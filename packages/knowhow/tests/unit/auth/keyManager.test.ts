import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  generateKeyPair,
  loadKeyPair,
  signMessage,
} from "../../../src/auth/keyManager";

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

  it("does not overwrite a partial identity", () => {
    fs.writeFileSync(identity, "existing key");
    expect(() => generateKeyPair(identity)).toThrow("a key file already exists");
    expect(fs.readFileSync(identity, "utf8")).toBe("existing key");
  });
});
