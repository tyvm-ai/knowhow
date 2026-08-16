import fs from "fs";
import os from "os";
import path from "path";
import http from "../utils/http";
import { getCliUserAgent } from "./browserLogin";
import {
  getDefaultPrivateKeyPath,
  keyPairExists,
  loadKeyPair,
  signMessage,
} from "./keyManager";

const DEFAULT_API_URL = process.env.KNOWHOW_API_URL || "https://api.knowhow.tyvm.ai";

/**
 * This is intentionally based only on the selected identity. Registration is
 * server-side and scoped to its environment/user/org; a local `.registered`
 * marker cannot safely represent that state. An unknown or revoked key is
 * cheaply rejected by the selected API and login then falls back to PKCE.
 */
export function hasKeyPair(privateKeyPath?: string): boolean {
  return keyPairExists(privateKeyPath);
}

/** Exchange a registered Ed25519 identity for a new short-lived JWT. */
export async function exchangePublicKeyJwt(
  orgId: string,
  apiUrl: string = DEFAULT_API_URL,
  privateKeyPath?: string
): Promise<string> {
  if (!keyPairExists(privateKeyPath)) {
    throw new Error("CLI identity is unavailable");
  }

  const keyPair = loadKeyPair(privateKeyPath);
  const headers = { "User-Agent": getCliUserAgent() };
  const challengeResponse = await http.post<{
    challengeId: string;
    message: string;
    expiresAt: string;
  }>(
    `${apiUrl}/api/public-keys/challenge`,
    { publicKey: keyPair.publicKeyBase64, orgId },
    { headers }
  );
  const { challengeId, message } = challengeResponse.data;
  if (
    typeof challengeId !== "string" ||
    challengeId.length === 0 ||
    challengeId.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(challengeId) ||
    typeof message !== "string" ||
    message.length === 0
  ) {
    throw new Error("Public-key challenge response is invalid");
  }

  const response = await http.post<{ jwt: string }>(
    `${apiUrl}/api/public-keys/authenticate`,
    { challengeId, signature: signMessage(message, privateKeyPath) },
    { headers }
  );
  if (!response.data.jwt) {
    throw new Error("Public-key authentication returned no JWT");
  }
  return response.data.jwt;
}

/**
 * Try the configured identity first, then the default CLI identity. Project
 * configs can outlive temporary/custom keys, while the globally registered
 * default identity remains valid.
 */
export async function exchangeAvailablePublicKeyJwt(
  orgId: string,
  apiUrl: string = DEFAULT_API_URL,
  preferredPrivateKeyPath?: string
): Promise<string> {
  const defaultPath = getDefaultPrivateKeyPath();
  const candidates = Array.from(
    new Set([preferredPrivateKeyPath, defaultPath].filter((value): value is string => Boolean(value)))
  ).filter((candidate) => keyPairExists(candidate));
  if (candidates.length === 0) throw new Error("CLI identity is unavailable");

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await exchangePublicKeyJwt(orgId, apiUrl, candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function authenticateWithKey(
  orgId: string,
  apiUrl: string = DEFAULT_API_URL,
  privateKeyPath?: string
): Promise<boolean> {
  if (!keyPairExists(privateKeyPath) && !keyPairExists()) return false;

  try {
    storeJwt(await exchangeAvailablePublicKeyJwt(orgId, apiUrl, privateKeyPath));
    return true;
  } catch (error: unknown) {
    // The identity is not registered for this environment/org (or was revoked).
    if (http.isHttpError(error) && (error.status === 401 || error.status === 404)) {
      return false;
    }
    throw error;
  }
}

/** Register an Ed25519 identity; the backend derives its scope from the source JWT. */
export async function registerPublicKey(
  jwt: string,
  publicKeyBase64: string,
  apiUrl: string = DEFAULT_API_URL
): Promise<void> {
  const rawPublicKey = Buffer.from(publicKeyBase64, "base64");
  if (rawPublicKey.length !== 32 || rawPublicKey.toString("base64") !== publicKeyBase64) {
    throw new Error("CLI authentication requires a 32-byte Ed25519 public key");
  }

  await http.post(
    `${apiUrl}/api/public-keys/register`,
    {
      publicKey: publicKeyBase64,
      label: os.hostname(),
    },
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "User-Agent": getCliUserAgent(),
      },
    }
  );
}

export function storeJwt(jwt: string): void {
  const jwtFilePath = path.join(process.cwd(), ".knowhow", ".jwt");
  const directory = path.dirname(jwtFilePath);
  const temporaryPath = `${jwtFilePath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporaryPath, jwt, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, jwtFilePath);
    fs.chmodSync(jwtFilePath, 0o600);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}
