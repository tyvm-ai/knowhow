import { Config } from "../types";
import { loadJwtFromDisk } from "./jwtStore";
import { createRemote, findRemoteForApi, registerRemote } from "../remotes";

/** Stable config key for authentication state owned by one API deployment. */
export function getApiEnvironmentKey(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return apiUrl.replace(/\/+$/, "").toLowerCase();
  }
}

/** Read an organization claim without trusting the JWT for authorization. */
export function getOrgIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const orgId = payload.org ?? payload.orgId ?? payload.org_id ?? payload.organizationId;
    return typeof orgId === "string" && orgId ? orgId : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the org for the selected API without leaking another environment's org. */
export function getOrgIdForApi(config: Config, apiUrl: string): string | undefined {
  const remote = findRemoteForApi(config, apiUrl);
  if (remote?.orgId) return remote.orgId;

  // Read old orgIds only until this API has been represented as a remote.
  const environmentKey = getApiEnvironmentKey(apiUrl);
  const configured = config.orgIds?.[environmentKey];
  if (configured) return configured;

  const tokenOrgId = getOrgIdFromJwt(loadJwtFromDisk(apiUrl));
  if (tokenOrgId) return tokenOrgId;

  return config.remotes || (config.orgIds && Object.keys(config.orgIds).length > 0)
    ? undefined
    : config.orgId;
}

/** Record authentication state on the remote that owns it. */
export function setOrgIdForApi(config: Config, apiUrl: string, orgId: string): void {
  const remote = findRemoteForApi(config, apiUrl) ?? createRemote("origin", apiUrl);
  registerRemote(config, { ...remote, orgId });
  delete config.orgId;
}
