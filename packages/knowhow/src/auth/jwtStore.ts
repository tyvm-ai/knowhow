import fs from "fs";
import path from "path";
import { findRemoteForApiSync, resolveJwtPath } from "../remotes";

const PRODUCTION_API_HOST = "api.knowhow.tyvm.ai";

/** Return a readable, environment-specific JWT filename for an API URL. */
export function getJwtFileName(apiUrl: string): string {
  try {
    const { hostname, port } = new URL(apiUrl);
    const normalizedHost = hostname.toLowerCase();

    if (normalizedHost === PRODUCTION_API_HOST) return ".jwt";
    if (
      normalizedHost === "localhost" ||
      normalizedHost === "::1" ||
      normalizedHost.startsWith("127.")
    ) {
      return ".jwt.local";
    }
    if (normalizedHost === "api.dev.knowhow.tyvm.ai" || normalizedHost.includes(".dev.")) {
      return ".jwt.dev";
    }

    const environment = `${normalizedHost}${port ? `-${port}` : ""}`
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return environment ? `.jwt.${environment}` : ".jwt";
  } catch {
    return ".jwt";
  }
}

export function getJwtFilePath(
  apiUrl: string,
  configDir = path.join(process.cwd(), ".knowhow")
): string {
  return path.join(configDir, getJwtFileName(apiUrl));
}

/**
 * Load the JWT selected for an environment. The optional legacy path provides
 * the directory for configs that historically pointed at `.jwt`.
 */
export function loadJwtFromDisk(apiUrl: string, legacyPath?: string): string {
  const basePath = legacyPath ?? path.join(process.cwd(), ".knowhow", ".jwt");
  const configuredPath = findRemoteForApiSync(apiUrl)?.jwtPath;
  const jwtPath = configuredPath
    ? resolveJwtPath(configuredPath)
    : path.join(path.dirname(basePath), getJwtFileName(apiUrl));
  return fs.existsSync(jwtPath)
    ? fs.readFileSync(jwtPath, "utf8").trim()
    : "";
}

/** Atomically store a JWT in the file selected for the API environment. */
export function storeJwtForApi(jwt: string, apiUrl: string, configuredPath?: string): string {
  const jwtFilePath = configuredPath ? resolveJwtPath(configuredPath) : getJwtFilePath(apiUrl);
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
  return jwtFilePath;
}
