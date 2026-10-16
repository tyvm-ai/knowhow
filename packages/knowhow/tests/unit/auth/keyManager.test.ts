import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureIdentityKeyPair,
  generateKeyPair,
  loadKeyPair,
  signMessage,
} from "../../../src/auth/keyManager";

const OPENSSH_ED25519_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACD/E7YSDZcV7usL3Ej3SSvGNVuNMu1hYFOpHjQaCodvIgAAAIgKqccyCqnH
MgAAAAtzc2gtZWQyNTUxOQAAACD/E7YSDZcV7usL3Ej3SSvGNVuNMu1hYFOpHjQaCodvIg
AAAECC40JKj3sb9Q3KsA9wAKeLbUwazUi7cuBiDfuJHDybtf8TthINlxXu6wvcSPdJK8Y1
W40y7WFgU6keNBoKh28iAAAABHRlc3QB
-----END OPENSSH PRIVATE KEY-----
`;

const OPENSSH_ED25519_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP8TthINlxXu6wvcSPdJK8Y1W40y7WFgU6keNBoKh28i test\n";

const OPENSSH_ENCRYPTED_ED25519_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAiFkZE2t
9UBWLQLB8sAuG7AAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAID2OnkCi/hq0EH9E
yBf1n4FXRDw16RYyDAL0pbbRWh1JAAAAkHNPoqbcZcef7FZY+dFTRTODyAMPL4gyzOxGLE
JffXux9KUTPBrCy+xfScoAHq9JFKrspli5h5Z6PyJ7Dp2NNJPOzEaF92fv6989AETm3X3X
2pOUvtPMJz29C1MO7hXHlReIWqF6nkaDGGcNEZMZ3xHI4ypB/lfceH6A1IjxZEa2BXJfJe
y6h8co4T89tJdubQ==
-----END OPENSSH PRIVATE KEY-----
`;

describe("keyManager", () => {
  let directory: string;
  let identity: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-key-manager-"));
    identity = path.join(directory, "identity");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates an Ed25519 identity with an OpenSSH-compatible public key", () => {
    const generated = generateKeyPair(identity);
    const publicKeyLine = fs.readFileSync(`${identity}.pub`, "utf8").trim();

    expect(publicKeyLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* knowhow-cli$/);
    expect(fs.statSync(identity).mode % 0o1000).toBe(0o600);
    expect(loadKeyPair(identity)).toEqual(generated);

    const challengeMessage = "exact server-provided challenge";
    const signature = signMessage(challengeMessage, identity);
    const publicKey = crypto.createPublicKey(fs.readFileSync(identity));
    expect(
      crypto.verify(
        null,
        Buffer.from(challengeMessage),
        publicKey,
        Buffer.from(signature, "base64")
      )
    ).toBe(true);
  });

  it("accepts default unencrypted OpenSSH Ed25519 private keys", () => {
    fs.writeFileSync(identity, OPENSSH_ED25519_PRIVATE_KEY);
    fs.writeFileSync(`${identity}.pub`, OPENSSH_ED25519_PUBLIC_KEY);

    const loaded = loadKeyPair(identity);
    expect(loaded.publicKeyBase64).toBe("/xO2Eg2XFe7rC9xI90krxjVbjTLtYWB TqR40GgqHbyI=".replace(/\s+/g, ""));

    const signature = signMessage("challenge", identity);
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKeyDer = Buffer.concat([spkiPrefix, Buffer.from(loaded.publicKeyBase64, "base64")]);
    const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    expect(
      crypto.verify(
        null,
        Buffer.from("challenge"),
        publicKey,
        Buffer.from(signature, "base64")
      )
    ).toBe(true);
  });

  it("loads legacy raw-base64 public keys but rejects non-Ed25519 identities", () => {
    const generated = generateKeyPair(identity);
    fs.writeFileSync(`${identity}.pub`, generated.publicKeyBase64);
    expect(loadKeyPair(identity).publicKeyBase64).toBe(generated.publicKeyBase64);

    const rsaIdentity = path.join(directory, "rsa");
    const rsa = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    fs.writeFileSync(rsaIdentity, rsa.privateKey);
    fs.writeFileSync(`${rsaIdentity}.pub`, generated.publicKeyBase64);

    expect(() => loadKeyPair(rsaIdentity)).toThrow("must be an Ed25519 private key");
  });

  it("rejects encrypted OpenSSH keys with a clear error", () => {
    fs.writeFileSync(identity, OPENSSH_ENCRYPTED_ED25519_PRIVATE_KEY);
    fs.writeFileSync(`${identity}.pub`, OPENSSH_ED25519_PUBLIC_KEY);

    expect(() => loadKeyPair(identity)).toThrow("encrypted OpenSSH key");
  });

  it("does not overwrite a partial identity", () => {
    fs.writeFileSync(identity, "existing key");
    expect(() => generateKeyPair(identity)).toThrow("a key file already exists");
    expect(fs.readFileSync(identity, "utf8")).toBe("existing key");
  });

  it("ensureIdentityKeyPair is safe for existing keys (no overwrite)", () => {
    const generated = generateKeyPair(identity);
    const beforePrivate = fs.readFileSync(identity, "utf8");
    const beforePublic = fs.readFileSync(`${identity}.pub`, "utf8");

    const result = ensureIdentityKeyPair(identity);
    expect(result.created).toBe(false);
    expect(result.keyPair).toEqual(generated);
    expect(fs.readFileSync(identity, "utf8")).toBe(beforePrivate);
    expect(fs.readFileSync(`${identity}.pub`, "utf8")).toBe(beforePublic);
  });
});
