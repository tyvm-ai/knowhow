import path from "path";
import { getOrCreatePublicKey } from "./keyManager";
import { registerPublicKey, exchangePublicKeyJwt, storeJwt } from "./keyAuth";
import { getConfig, updateConfig } from "../config";
import { getJwtFilePath, loadJwtFromDisk } from "./jwtStore";
import { setOrgIdForApi } from "./environmentAuth";

export interface RegisterIdentityOptions {
  /** Optional Ed25519 private-key path. Defaults to ~/.knowhow/keys/id_ed25519. */
  identityPath?: string;
  /** API base URL. Defaults to KNOWHOW_API_URL or the production public API. */
  apiUrl?: string;
}

/** Decode an unverified JWT payload for local routing information only. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format: expected 3 parts");
  const base64 = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const payload: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JWT payload: could not parse JSON");
  }
}

export function extractOrgIdFromJwt(jwt: string): string {
  const payload = decodeJwtPayload(jwt);
  const orgId = payload.org ?? payload.orgId ?? payload.org_id ?? payload.organizationId;
  if (typeof orgId !== "string" || !orgId) {
    throw new Error("JWT does not contain an organization claim (expected org, orgId, org_id, or organizationId)");
  }
  return orgId;
}

/**
 * Register a CLI identity using the JWT stored for the selected API, then
 * replace that JWT with one obtained via key authentication.
 * This is intentionally generic: authorization scope is derived by the backend
 * from the verified source JWT.
 */
export async function registerIdentity(options: RegisterIdentityOptions = {}): Promise<void> {
  const apiUrl = options.apiUrl ?? process.env.KNOWHOW_API_URL ?? "https://api.knowhow.tyvm.ai";
  const jwtPath = getJwtFilePath(apiUrl);
  const sourceJwt = loadJwtFromDisk(apiUrl);
  if (!sourceJwt) throw new Error(`JWT file is empty: ${jwtPath}`);

  const orgId = extractOrgIdFromJwt(sourceJwt);
  const keyPair = getOrCreatePublicKey(options.identityPath);
  await registerPublicKey(sourceJwt, keyPair.publicKeyBase64, apiUrl);
  const identityJwt = await exchangePublicKeyJwt(orgId, apiUrl, options.identityPath);
  storeJwt(identityJwt, apiUrl);

  const config = await getConfig();
  if (!config.modelProviders) config.modelProviders = [];
  if (!config.modelProviders.some((provider: { provider: string }) => provider.provider === "knowhow")) {
    config.modelProviders.push({ provider: "knowhow" });
  }
  setOrgIdForApi(config, apiUrl, orgId);
  config.cliIdentityPath = path.resolve(options.identityPath ?? keyPair.privateKeyPath);
  await updateConfig(config);

  console.log(`✅ Identity registered. Identity: ${keyPair.fingerprint}, Org: ${orgId}`);
}
