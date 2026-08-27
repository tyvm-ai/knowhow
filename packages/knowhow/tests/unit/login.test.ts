const httpGet = jest.fn();
const browserLogin = jest.fn();
const hasKeyPair = jest.fn();
const authenticateWithKey = jest.fn();
const registerPublicKey = jest.fn();
const getOrCreatePublicKey = jest.fn();
const getConfig = jest.fn();
const updateConfig = jest.fn();

jest.mock("../../src/utils/http", () => ({
  __esModule: true,
  default: { get: httpGet, isHttpError: () => false },
}));

jest.mock("../../src/services/KnowhowClient", () => ({
  KNOWHOW_API_URL: "https://api.example",
}));

jest.mock("../../src/auth/browserLogin", () => ({
  BrowserLoginService: jest.fn().mockImplementation(() => ({ login: browserLogin })),
}));

jest.mock("../../src/auth/keyAuth", () => ({
  hasKeyPair,
  authenticateWithKey,
  registerPublicKey,
}));

jest.mock("../../src/auth/keyManager", () => ({
  getDefaultPrivateKeyPath: () => "/keys/default",
  getOrCreatePublicKey,
}));
jest.mock("../../src/config", () => ({ getConfig, updateConfig }));
jest.mock("../../src/utils", () => ({ ask: jest.fn() }));

import fs from "fs";
import os from "os";
import path from "path";
import { login } from "../../src/login";

describe("login public-key bootstrap", () => {
  const originalCwd = process.cwd();
  let workingDirectory: string;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-login-"));
    fs.mkdirSync(path.join(workingDirectory, ".knowhow"));
    fs.writeFileSync(path.join(workingDirectory, ".knowhow", ".jwt.api.example"), "raw-jwt");
    process.chdir(workingDirectory);
    hasKeyPair.mockReturnValue(false);
    browserLogin.mockResolvedValue(undefined);
    getConfig.mockResolvedValue({ modelProviders: [] });
    getOrCreatePublicKey.mockReturnValue({
      publicKeyBase64: "raw-key",
      fingerprint: "SHA256:key",
    });
    httpGet.mockResolvedValue({
      data: {
        orgId: "org-1",
        user: {
          email: "user@example.com",
          orgs: [{ organizationId: "org-1", organization: { id: "org-1", name: "Org" } }],
        },
      },
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(workingDirectory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("bootstraps the selected identity after PKCE without invalidating browser login on registration failure", async () => {
    registerPublicKey.mockRejectedValueOnce(new Error("endpoint unavailable"));

    await expect(login(false, "/keys/custom")).resolves.toBeUndefined();

    expect(browserLogin).toHaveBeenCalledTimes(1);
    expect(getOrCreatePublicKey).toHaveBeenCalledWith("/keys/custom");
    expect(registerPublicKey).toHaveBeenCalledWith(
      "raw-jwt",
      "raw-key",
      "https://api.example"
    );
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRemote: "api.example",
        modelProviders: [{ provider: "knowhow" }],
        remotes: expect.objectContaining({
          "api.example": {
            name: "api.example",
            apiUrl: "https://api.example",
            jwtPath: ".knowhow/.jwt.api.example",
            orgId: "org-1",
          },
        }),
      })
    );
  });

  it("persists an explicit --api-url as the authenticated remote", async () => {
    fs.writeFileSync(path.join(workingDirectory, ".knowhow", ".jwt.local"), "local-jwt");

    await login(false, undefined, "http://localhost:4000/", "local");

    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRemote: "local",
        remotes: expect.objectContaining({
          local: {
            name: "local",
            apiUrl: "http://localhost:4000",
            jwtPath: ".knowhow/.jwt.local",
            orgId: "org-1",
          },
        }),
      })
    );
    expect(httpGet).toHaveBeenCalledWith(
      "http://localhost:4000/api/users/me",
      expect.any(Object)
    );
  });

  it("does not persist a temporary identity path into project configuration", async () => {
    const temporaryIdentity = path.join(os.tmpdir(), "knowhow-login-test-key");
    getConfig.mockResolvedValue({
      orgId: "org-1",
      cliIdentityPath: "/tmp/knowhow-csrf-e2e-key",
      modelProviders: [],
    });
    registerPublicKey.mockResolvedValueOnce(undefined);

    await expect(login(false, temporaryIdentity)).resolves.toBeUndefined();

    expect(getOrCreatePublicKey).toHaveBeenCalledWith(temporaryIdentity);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig.mock.calls[0][0]).toEqual(
      expect.not.objectContaining({
        cliIdentityPath: expect.any(String),
      })
    );
  });

  it("persists the default identity selected during browser bootstrap", async () => {
    registerPublicKey.mockResolvedValueOnce(undefined);

    await expect(login(false)).resolves.toBeUndefined();

    expect(getOrCreatePublicKey).toHaveBeenCalledWith("/keys/default");
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        cliIdentityPath: "/keys/default",
        modelProviders: [{ provider: "knowhow" }],
        remotes: expect.objectContaining({ "api.example": expect.objectContaining({ orgId: "org-1" }) }),
      })
    );
  });

  it("safely falls back to browser PKCE when the selected key cannot authenticate", async () => {
    hasKeyPair.mockReturnValue(true);
    getConfig.mockResolvedValue({ orgId: "org-1", modelProviders: [] });
    authenticateWithKey.mockRejectedValueOnce(new Error("old backend"));
    registerPublicKey.mockResolvedValueOnce(undefined);

    await expect(login(false, "/keys/dev")).resolves.toBeUndefined();

    expect(authenticateWithKey).toHaveBeenCalledWith(
      "org-1",
      "https://api.example",
      "/keys/dev"
    );
    expect(browserLogin).toHaveBeenCalledTimes(1);
    expect(getOrCreatePublicKey).toHaveBeenCalledWith("/keys/dev");
  });

  it("uses the selected API's JWT org instead of an org saved by another environment", async () => {
    const devJwt = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
      JSON.stringify({ org: "org-dev" })
    ).toString("base64url")}.signature`;
    fs.writeFileSync(
      path.join(workingDirectory, ".knowhow", ".jwt.api.example"),
      devJwt
    );
    hasKeyPair.mockReturnValue(true);
    getConfig.mockResolvedValue({
      orgId: "org-local",
      orgIds: { "http://localhost:4000": "org-local" },
      modelProviders: [],
    });
    authenticateWithKey.mockResolvedValueOnce(true);

    await expect(login(false, "/keys/default")).resolves.toBeUndefined();

    expect(authenticateWithKey).toHaveBeenCalledWith(
      "org-dev",
      "https://api.example",
      "/keys/default"
    );
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it("does not attempt key authentication without a configured organization", async () => {
    hasKeyPair.mockReturnValue(true);
    getConfig.mockResolvedValue({ modelProviders: [] });
    registerPublicKey.mockResolvedValueOnce(undefined);

    await expect(login(false, "/keys/dev")).resolves.toBeUndefined();

    expect(hasKeyPair).not.toHaveBeenCalled();
    expect(authenticateWithKey).not.toHaveBeenCalled();
    expect(browserLogin).toHaveBeenCalledTimes(1);
  });
});
