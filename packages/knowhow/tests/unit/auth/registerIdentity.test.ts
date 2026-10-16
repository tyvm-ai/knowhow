import fs from "fs";
import os from "os";
import path from "path";

const registerPublicKey = jest.fn();
const exchangePublicKeyJwt = jest.fn();
const storeJwt = jest.fn();
const getOrCreatePublicKey = jest.fn();
const getConfig = jest.fn();
const updateConfig = jest.fn();

jest.mock("../../../src/auth/keyAuth", () => ({ registerPublicKey, exchangePublicKeyJwt, storeJwt }));
jest.mock("../../../src/auth/keyManager", () => ({ getOrCreatePublicKey }));
jest.mock("../../../src/config", () => ({ getConfig, updateConfig }));

import { decodeJwtPayload, extractOrgIdFromJwt, registerIdentity } from "../../../src/auth/registerIdentity";

function makeJwt(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

describe("registerIdentity", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  const sourceJwt = makeJwt({ org: "org-test" });
  const publicKeyBase64 = Buffer.alloc(32, 5).toString("base64");

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-register-identity-"));
    fs.mkdirSync(path.join(workDir, ".knowhow"), { recursive: true });
    fs.writeFileSync(path.join(workDir, ".knowhow", ".jwt"), sourceJwt);
    fs.writeFileSync(path.join(workDir, ".knowhow", ".jwt.api.example"), sourceJwt);
    process.chdir(workDir);
    getOrCreatePublicKey.mockReturnValue({
      publicKeyBase64,
      fingerprint: "SHA256:test",
      privateKeyPath: path.join(workDir, ".knowhow", "keys", "id_ed25519"),
    });
    registerPublicKey.mockResolvedValue(undefined);
    exchangePublicKeyJwt.mockResolvedValue("identity.jwt.token");
    getConfig.mockResolvedValue({ modelProviders: [] });
    updateConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("registers from the project JWT and stores the exchanged JWT", async () => {
    await registerIdentity({ apiUrl: "https://api.example" });
    expect(registerPublicKey).toHaveBeenCalledWith(sourceJwt, publicKeyBase64, "https://api.example");
    expect(exchangePublicKeyJwt).toHaveBeenCalledWith("org-test", "https://api.example", undefined);
    expect(storeJwt).toHaveBeenCalledWith("identity.jwt.token", "https://api.example");
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      modelProviders: [{ provider: "knowhow" }],
      cliIdentityPath: expect.stringContaining("id_ed25519"),
      remotes: {
        origin: expect.objectContaining({
          apiUrl: "https://api.example",
          orgId: "org-test",
        }),
      },
    }));
  });

  it("uses an explicitly selected identity", async () => {
    await registerIdentity({ identityPath: "/keys/id", apiUrl: "https://api.example" });
    expect(getOrCreatePublicKey).toHaveBeenCalledWith("/keys/id");
    expect(exchangePublicKeyJwt).toHaveBeenCalledWith("org-test", "https://api.example", "/keys/id");
  });

  it("requires a nonempty project JWT", async () => {
    fs.writeFileSync(path.join(workDir, ".knowhow", ".jwt"), " ");
    await expect(registerIdentity()).rejects.toThrow("JWT file is empty");
    expect(registerPublicKey).not.toHaveBeenCalled();
  });

  it("does not replace the JWT when registration fails", async () => {
    registerPublicKey.mockRejectedValue(new Error("registration failed"));
    await expect(registerIdentity()).rejects.toThrow("registration failed");
    expect(storeJwt).not.toHaveBeenCalled();
  });
});

describe("JWT organization extraction", () => {
  it("decodes payload and accepts canonical org", () => {
    expect(decodeJwtPayload(makeJwt({ org: "one" }))).toMatchObject({ org: "one" });
    expect(extractOrgIdFromJwt(makeJwt({ org: "one" }))).toBe("one");
  });

  it("rejects malformed and organization-less JWTs", () => {
    expect(() => decodeJwtPayload("invalid")).toThrow("Invalid JWT format");
    expect(() => extractOrgIdFromJwt(makeJwt({ sub: "user" }))).toThrow("organization claim");
  });
});
