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
  keyPairExists,
  loadKeyPair,
  signMessage,
}));

jest.mock("../../../src/auth/browserLogin", () => ({
  getCliUserAgent: () => "test-agent",
}));

import {
  authenticateWithKey,
  exchangePublicKeyJwt,
  hasKeyPair,
  registerPublicKey,
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

  it("falls back when the key is unavailable without signing a challenge", async () => {
    post.mockRejectedValueOnce({ status: 401 });

    await expect(
      authenticateWithKey("org-1", "https://work.example", "/keys/work")
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(1);
    expect(signMessage).not.toHaveBeenCalled();
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
