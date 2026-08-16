import fs from "fs";

const mockGet = jest.fn();
const mockExchangePublicKeyJwt = jest.fn();
const mockStoreJwt = jest.fn();

jest.mock("../../../src/utils/http", () => {
  const actual = jest.requireActual("../../../src/utils/http");
  const mockedHttp = {
    get: (...args: unknown[]) => mockGet(...args),
  };
  return {
    __esModule: true,
    ...actual,
    http: mockedHttp,
    default: mockedHttp,
  };
});

jest.mock("../../../src/config", () => ({
  getConfigSync: jest.fn().mockReturnValue({
    orgId: "org-1",
    cliIdentityPath: "/tmp/identity",
  }),
}));

jest.mock("../../../src/auth/keyManager", () => ({
  keyPairExists: jest.fn().mockReturnValue(true),
}));

jest.mock("../../../src/auth/keyAuth", () => ({
  exchangeAvailablePublicKeyJwt: (...args: unknown[]) => mockExchangePublicKeyJwt(...args),
  storeJwt: (...args: unknown[]) => mockStoreJwt(...args),
}));

import { KnowhowSimpleClient } from "../../../src/services/KnowhowClient";

describe("KnowhowSimpleClient identity renewal", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("obtains a JWT from the registered identity before loading models when no JWT exists", async () => {
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    mockExchangePublicKeyJwt.mockResolvedValue("fresh-jwt");
    mockGet.mockResolvedValueOnce({ data: { data: [] } });

    const client = new KnowhowSimpleClient("https://api.example.test");
    await client.getModels();

    expect(mockExchangePublicKeyJwt).toHaveBeenCalledWith(
      "org-1",
      "https://api.example.test",
      "/tmp/identity"
    );
    expect(mockStoreJwt).toHaveBeenCalledWith("fresh-jwt");
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh-jwt");
  });

  it("replaces an expired JWT with one signed by the registered identity before loading models", async () => {
    const expiredJwt = [
      Buffer.from('{"alg":"none"}').toString("base64url"),
      Buffer.from('{"exp":0}').toString("base64url"),
      "old-signature",
    ].join(".");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "readFileSync").mockReturnValue(expiredJwt);
    mockExchangePublicKeyJwt.mockResolvedValue("fresh-jwt");
    mockGet.mockResolvedValueOnce({ data: { data: [] } });

    const client = new KnowhowSimpleClient("https://api.example.test");
    await client.getModels();

    expect(mockExchangePublicKeyJwt).toHaveBeenCalledWith(
      "org-1",
      "https://api.example.test",
      "/tmp/identity"
    );
    expect(mockStoreJwt).toHaveBeenCalledWith("fresh-jwt");
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe("Bearer fresh-jwt");
  });
});
