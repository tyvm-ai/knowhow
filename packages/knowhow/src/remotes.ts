import fs from "fs";
import path from "path";
import { Config, KnowhowRemote } from "./types";

export const DEFAULT_REMOTE_NAME = "origin";
export const DEFAULT_API_URL = "https://api.knowhow.tyvm.ai";

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Remote URL must use http or https: ${apiUrl}`);
  }
  return url.toString().replace(/\/$/, "");
}

export function defaultJwtPath(apiUrl: string): string {
  const normalized = normalizeApiUrl(apiUrl);
  if (normalized === DEFAULT_API_URL) return ".knowhow/.jwt";
  const { hostname, port } = new URL(normalized);
  let suffix: string;
  if (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")) {
    suffix = "local";
  } else if (hostname === "api.dev.knowhow.tyvm.ai" || hostname.includes(".dev.")) {
    suffix = "dev";
  } else {
    suffix = `${hostname}${port ? `-${port}` : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  return `.knowhow/.jwt.${suffix}`;
}

export function createRemote(name: string, apiUrl: string): KnowhowRemote {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error("Remote names may only contain letters, numbers, '.', '_' and '-'.");
  }
  const normalizedUrl = normalizeApiUrl(apiUrl);
  return { name, apiUrl: normalizedUrl, jwtPath: defaultJwtPath(normalizedUrl) };
}

export function getConfiguredRemotes(config: Config): Record<string, KnowhowRemote> {
  return config.remotes ?? {};
}

export function findRemoteForApi(config: Config, apiUrl: string): KnowhowRemote | undefined {
  const normalizedUrl = normalizeApiUrl(apiUrl);
  return Object.values(getConfiguredRemotes(config)).find(
    (remote) => normalizeApiUrl(remote.apiUrl) === normalizedUrl
  );
}

export function findRemoteForApiSync(apiUrl: string): KnowhowRemote | undefined {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), ".knowhow", "knowhow.json"), "utf8")
    ) as Config;
    return findRemoteForApi(config, apiUrl);
  } catch {
    return undefined;
  }
}

export function getActiveRemote(config: Config): KnowhowRemote {
  const envUrl = process.env.KNOWHOW_API_URL;
  if (envUrl) {
    return findRemoteForApi(config, envUrl) ?? createRemote(inferRemoteName(envUrl), envUrl);
  }
  const name = config.activeRemote ?? DEFAULT_REMOTE_NAME;
  return config.remotes?.[name] ?? createRemote(DEFAULT_REMOTE_NAME, DEFAULT_API_URL);
}

export function getActiveRemoteSync(): KnowhowRemote {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), ".knowhow", "knowhow.json"), "utf8")
    ) as Config;
    return getActiveRemote(config);
  } catch {
    const apiUrl = process.env.KNOWHOW_API_URL ?? DEFAULT_API_URL;
    return createRemote(inferRemoteName(apiUrl), apiUrl);
  }
}

export function registerRemote(config: Config, remote: KnowhowRemote): void {
  const migratedRemotes: Record<string, KnowhowRemote> = {};
  for (const [apiUrl, orgId] of Object.entries(config.orgIds ?? {})) {
    const name = inferRemoteName(apiUrl);
    migratedRemotes[name] = {
      ...createRemote(name, apiUrl),
      orgId,
    };
  }
  config.remotes = { ...migratedRemotes, ...(config.remotes ?? {}), [remote.name]: remote };
  delete config.orgIds;
}

export function inferRemoteName(apiUrl: string): string {
  const normalized = normalizeApiUrl(apiUrl);
  if (normalized === DEFAULT_API_URL) return DEFAULT_REMOTE_NAME;
  const { hostname } = new URL(normalized);
  if (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")) return "local";
  if (hostname === "api.dev.knowhow.tyvm.ai" || hostname.includes(".dev.")) return "dev";
  return hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

export function resolveJwtPath(jwtPath: string): string {
  return path.resolve(process.cwd(), jwtPath);
}
