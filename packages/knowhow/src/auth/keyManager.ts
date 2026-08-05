import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const ED25519_KEY_TYPE = "ssh-ed25519";
const ED25519_RAW_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface KeyPair {
  privateKeyPath: string;
  publicKeyPath: string;
  /** Raw 32-byte Ed25519 key, base64 encoded for the authentication API. */
  publicKeyBase64: string;
  /** OpenSSH SHA-256 fingerprint (hashes the SSH wire-format public key). */
  fingerprint: string;
}

export function getKeyDir(): string {
  return path.join(os.homedir(), ".knowhow", "keys");
}

export function getDefaultPrivateKeyPath(): string {
  return path.join(getKeyDir(), "id_ed25519");
}

export function getDefaultPublicKeyPath(): string {
  return `${getDefaultPrivateKeyPath()}.pub`;
}

export function keyPairExists(privateKeyPath?: string): boolean {
  const privatePath = privateKeyPath ?? getDefaultPrivateKeyPath();
  return fs.existsSync(privatePath) && fs.existsSync(`${privatePath}.pub`);
}

/** Generate a CLI-only Ed25519 key and an OpenSSH-compatible public-key file. */
export function generateKeyPair(privateKeyPath?: string): KeyPair {
  const privatePath = privateKeyPath ?? getDefaultPrivateKeyPath();
  const publicPath = `${privatePath}.pub`;

  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const rawPublicKey = extractRawPublicKey(publicKey);

  // Refuse to overwrite either half of an identity. Partial identities should be
  // repaired explicitly rather than silently replacing a user's key.
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
    throw new Error(`Cannot generate identity: a key file already exists at ${privatePath} or ${publicPath}`);
  }

  fs.writeFileSync(privatePath, privateKey, { mode: 0o600, flag: "wx" });
  try {
    fs.writeFileSync(publicPath, formatOpenSshPublicKey(rawPublicKey), {
      mode: 0o644,
      flag: "wx",
    });
  } catch (error) {
    fs.rmSync(privatePath, { force: true });
    throw error;
  }

  return keyPairMetadata(privatePath, rawPublicKey);
}

/** Load and validate an Ed25519 identity. Legacy raw-base64 .pub files remain supported. */
export function loadKeyPair(privateKeyPath?: string): KeyPair {
  const privatePath = privateKeyPath ?? getDefaultPrivateKeyPath();
  const publicPath = `${privatePath}.pub`;
  if (!fs.existsSync(privatePath)) throw new Error(`Private key not found at: ${privatePath}`);
  if (!fs.existsSync(publicPath)) throw new Error(`Public key not found at: ${publicPath}`);

  const privateKey = readEd25519PrivateKey(privatePath);
  const publicKey = parsePublicKey(fs.readFileSync(publicPath, "utf8"));
  const derivedPublicKey = extractRawPublicKey(
    crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" })
  );
  if (!crypto.timingSafeEqual(publicKey, derivedPublicKey)) {
    throw new Error(`Public key does not match private key: ${publicPath}`);
  }

  return keyPairMetadata(privatePath, publicKey);
}

export function getOrCreatePublicKey(privateKeyPath?: string): KeyPair {
  return keyPairExists(privateKeyPath)
    ? loadKeyPair(privateKeyPath)
    : generateKeyPair(privateKeyPath);
}

export function signMessage(message: string, privateKeyPath?: string): string {
  const privatePath = privateKeyPath ?? getDefaultPrivateKeyPath();
  if (!fs.existsSync(privatePath)) throw new Error(`Private key not found at: ${privatePath}`);
  return crypto.sign(null, Buffer.from(message, "utf8"), readEd25519PrivateKey(privatePath)).toString("base64");
}

function readEd25519PrivateKey(privatePath: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(fs.readFileSync(privatePath));
  } catch {
    throw new Error(`Identity at ${privatePath} is not a supported PEM Ed25519 private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Identity at ${privatePath} must be an Ed25519 private key`);
  }
  return key;
}

function extractRawPublicKey(spkiDer: Buffer): Buffer {
  if (
    spkiDer.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH ||
    !spkiDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("Invalid Ed25519 public key");
  }
  return spkiDer.subarray(ED25519_SPKI_PREFIX.length);
}

function sshPublicKeyBlob(rawPublicKey: Buffer): Buffer {
  const type = Buffer.from(ED25519_KEY_TYPE, "ascii");
  const typeLength = Buffer.alloc(4);
  const keyLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(type.length);
  keyLength.writeUInt32BE(rawPublicKey.length);
  return Buffer.concat([typeLength, type, keyLength, rawPublicKey]);
}

function formatOpenSshPublicKey(rawPublicKey: Buffer): string {
  return `${ED25519_KEY_TYPE} ${sshPublicKeyBlob(rawPublicKey).toString("base64")} knowhow-cli\n`;
}

function parsePublicKey(value: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.startsWith(`${ED25519_KEY_TYPE} `)) {
    const parts = trimmed.split(/\s+/);
    const blob = Buffer.from(parts[1] ?? "", "base64");
    const expected = sshPublicKeyBlob(blob.subarray(blob.length - ED25519_RAW_KEY_LENGTH));
    if (blob.length !== expected.length || !blob.equals(expected)) {
      throw new Error("Invalid OpenSSH Ed25519 public key");
    }
    return blob.subarray(blob.length - ED25519_RAW_KEY_LENGTH);
  }

  // Compatibility with key files written by early CLI builds.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error("Public key must be an OpenSSH Ed25519 key");
  }
  const raw = Buffer.from(trimmed, "base64");
  if (raw.length !== ED25519_RAW_KEY_LENGTH || raw.toString("base64") !== trimmed) {
    throw new Error("Ed25519 public key must contain exactly 32 bytes");
  }
  return raw;
}

function keyPairMetadata(privatePath: string, rawPublicKey: Buffer): KeyPair {
  const hash = crypto.createHash("sha256").update(sshPublicKeyBlob(rawPublicKey)).digest("base64").replace(/=+$/, "");
  return {
    privateKeyPath: privatePath,
    publicKeyPath: `${privatePath}.pub`,
    publicKeyBase64: rawPublicKey.toString("base64"),
    fingerprint: `SHA256:${hash}`,
  };
}
