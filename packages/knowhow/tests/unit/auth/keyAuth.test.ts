const post = jest.fn();
const publicKeyBase64 = Buffer.alloc(32, 7).toString("base64");
const keyPairExists = jest.fn(() => true);
const loadKeyPair = jest.fn(() => ({ publicKeyBase64 }));
const signMessage = jest.fn(() => "server-message-signature");

jest.mock("../../../src/utils/http", () => ({
  __esModule: true,
  default: {
    post,
    isHttpError: (error: unknown) =>
      typeof error === "object" && error !== null && "status" in error,
  },
}));

jest.mock("../../../src/auth/keyManager", () => ({
  getDefaultPrivateKeyPath: () => "/keys/default",
  keyPairExists,
  loadKeyPair,
  signMessage,
}));

jest.mock("../../../src/auth/browserLogin", () => ({
  getCliUserAgent: () => "test-agent",
}));

import fs from "fs";
import os from "os";
import path from "path";
import {
  authenticateWithKey,
  exchangeAvailablePublicKeyJwt,
  exchangePublicKeyJwt,
  hasKeyPair,
  registerPublicKey,
  storeJwt,
} from "../../../src/auth/keyAuth";

describe("keyAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    keyPairExists.mockReturnValue(true);
  });

  it("signs the exact server challenge for the selected key, org, and environment", async () => {
    post
      .mockResolvedValueOnce({
        data: {
          challengeId: "challenge_1",
          message: "exact message from server",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        status: 201,
      })
      .mockResolvedValueOnce({ data: { jwt: "renewed-jwt" }, status: 200 });

    expect(hasKeyPair("/keys/work")).toBe(true);
    await expect(
      exchangePublicKeyJwt("org-1", "https://work.example", "/keys/work")
    ).resolves.toBe("renewed-jwt");

    expect(loadKeyPair).toHaveBeenCalledWith("/keys/work");
    expect(signMessage).toHaveBeenCalledWith("exact message from server", "/keys/work");
    expect(post.mock.calls).toEqual([
      [
        "https://work.example/api/public-keys/challenge",
        { publicKey: publicKeyBase64, orgId: "org-1" },
        { headers: { "User-Agent": "test-agent" } },
      ],
      [
        "https://work.example/api/public-keys/authenticate",
        { challengeId: "challenge_1", signature: "server-message-signature" },
        { headers: { "User-Agent": "test-agent" } },
      ],
    ]);
  });

  it("uses the registered default identity when a configured identity is rejected", async () => {
    post
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce({
        data: {
          challengeId: "challenge_2",
          message: "default key challenge",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        status: 201,
      })
      .mockResolvedValueOnce({ data: { jwt: "default-key-jwt" }, status: 200 });

    await expect(
      exchangeAvailablePublicKeyJwt("org-1", "https://work.example", "/keys/stale")
    ).resolves.toBe("default-key-jwt");

    expect(loadKeyPair.mock.calls).toEqual([
      ["/keys/stale"],
      ["/keys/default"],
    ]);
    expect(signMessage).toHaveBeenCalledWith(
      "default key challenge",
      "/keys/default"
    );
  });

  it("falls back when the key is unavailable without signing a challenge", async () => {
    post.mockRejectedValue({ status: 401 });

    await expect(
      authenticateWithKey("org-1", "https://work.example", "/keys/work")
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(2);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("stores a refreshed JWT in the active isolated project", () => {
    const originalCwd = process.cwd();
    const temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-key-auth-"));
    try {
      process.chdir(temporaryProject);

      storeJwt("fresh-project-jwt");

      const jwtPath = path.join(temporaryProject, ".knowhow", ".jwt");
      expect(fs.readFileSync(jwtPath, "utf8")).toBe("fresh-project-jwt");
      expect(fs.statSync(jwtPath).mode & 0o777).toBe(0o600);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(temporaryProject, { recursive: true, force: true });
    }
  });

  it("registers only server-owned Ed25519 key fields in the selected environment", async () => {
    post.mockResolvedValueOnce({ data: {}, status: 201 });

    await registerPublicKey("browser-jwt", publicKeyBase64, "https://dev.example");

    expect(post).toHaveBeenCalledWith(
      "https://dev.example/api/public-keys/register",
      {
        publicKey: publicKeyBase64,
        label: expect.any(String),
      },
      {
        headers: {
          Authorization: "Bearer browser-jwt",
          "User-Agent": "test-agent",
        },
      }
    );
  });
});
