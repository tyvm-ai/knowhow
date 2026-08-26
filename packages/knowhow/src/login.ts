import http from "./utils/http";
import fs from "fs";
import os from "os";
import path from "path";
import { ask } from "./utils";
import { getConfig, updateConfig } from "./config";
import { KNOWHOW_API_URL } from "./services/KnowhowClient";
import { BrowserLoginService } from "./auth/browserLogin";
import { authenticateWithKey, hasKeyPair, registerPublicKey } from "./auth/keyAuth";
import { getDefaultPrivateKeyPath, getOrCreatePublicKey } from "./auth/keyManager";
import { storeJwtForApi } from "./auth/jwtStore";
import { getOrgIdForApi, setOrgIdForApi } from "./auth/environmentAuth";
import {
  createRemote,
  findRemoteForApi,
  inferRemoteName,
  registerRemote,
  resolveJwtPath,
} from "./remotes";
import { KnowhowRemote } from "./types";

/**
 * Log in to Knowhow.
 *
 * Strategy (in order):
 *   1. `--jwt`   flag: prompt for a raw JWT and write it to disk.
 *   2. Key auth: if an Ed25519 key and configured organization exist, sign a
 *                server challenge and exchange it for an organization-bound JWT.
 *   3. Browser:  open the browser approval flow (first-time login or key not yet registered).
 *
 * After any successful login the local config is updated with the current user's orgId.
 *
 * @param jwtFlag      True when --jwt flag is passed.
 * @param identityPath Optional path to a specific private key file (--identity flag).
 */
export async function login(
  jwtFlag?: boolean,
  identityPath?: string,
  apiUrl: string = KNOWHOW_API_URL,
  remoteName?: string
): Promise<void> {
  const config = await getConfig();
  const remote = findRemoteForApi(config, apiUrl) ??
    createRemote(remoteName ?? inferRemoteName(apiUrl), apiUrl);

  if (jwtFlag) {
    const jwt = await ask("Enter your JWT: ");
    const jwtFile = storeJwtForApi(jwt, remote.apiUrl, remote.jwtPath);
    console.log(`JWT updated successfully in ${path.relative(process.cwd(), jwtFile)}.`);
  } else {
    const selectedIdentityPath = identityPath ?? getDefaultPrivateKeyPath();
    const orgId = getOrgIdForApi(config, remote.apiUrl);

    if (orgId && hasKeyPair(selectedIdentityPath)) {
      console.log("Found CLI identity — authenticating with public key...");
      try {
        const success = await authenticateWithKey(orgId, remote.apiUrl, selectedIdentityPath);
        if (success) {
          console.log("✅ Successfully authenticated via public key!");
          return await postLoginConfigUpdate(remote, selectedIdentityPath);
        }
        console.warn("Key authentication returned no JWT, falling back to browser login...");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Key authentication failed (${message}), falling back to browser login...`);
      }
    }

    await doBrowserLogin(remote, selectedIdentityPath, orgId);
    identityPath = selectedIdentityPath;
  }

  await postLoginConfigUpdate(remote, identityPath);
}

/** Complete browser PKCE, then best-effort bootstrap the selected identity. */
async function doBrowserLogin(
  remote: KnowhowRemote,
  identityPath?: string,
  orgId?: string
): Promise<void> {
  console.log("Starting browser-based authentication...");
  try {
    const browserLoginService = new BrowserLoginService(remote.apiUrl, orgId);
    await browserLoginService.login();
    console.log("✅ Successfully authenticated via browser!");

    try {
      const keyPair = getOrCreatePublicKey(identityPath);
      await registerPublicKey(
        await loadJwt(remote),
        keyPair.publicKeyBase64,
        remote.apiUrl
      );
      console.log(`Registered CLI identity ${keyPair.fingerprint}`);
    } catch (registrationError: unknown) {
      // Browser login remains valid when key registration is unavailable (for
      // example during a rolling backend deployment or for a partial identity).
      const message = registrationError instanceof Error
        ? registrationError.message
        : String(registrationError);
      console.warn(`Could not register CLI identity (${message}). Browser login is still active.`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Browser authentication failed:", msg);
    console.log("You can try manual JWT login with: knowhow login --jwt");
    throw error;
  }
}

function isTemporaryIdentityPath(identityPath: string): boolean {
  const resolvedIdentity = path.resolve(identityPath);
  const temporaryRoots = new Set([os.tmpdir(), "/tmp", "/var/tmp"]);
  return Array.from(temporaryRoots).some((temporaryRoot) => {
    const relativePath = path.relative(path.resolve(temporaryRoot), resolvedIdentity);
    return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  });
}

/** After any successful login, update the local config with the current user/org. */
async function postLoginConfigUpdate(
  remote: KnowhowRemote,
  identityPath?: string
): Promise<void> {
  try {
    const storedJwt = await loadJwt(remote);
    const { user, currentOrg } = await checkJwt(storedJwt, remote.apiUrl);
    const orgId = currentOrg?.organizationId;

    console.log(
      `Current user: ${user.email}, \nOrganization: ${currentOrg?.organization?.name} - ${currentOrg?.organization?.id}`
    );

    const config = await getConfig();

    if (!config.modelProviders) {
      config.modelProviders = [];
    }

    const hasProvider = config.modelProviders.find(
      (provider: { provider: string }) => provider.provider === "knowhow"
    );
    if (!hasProvider) {
      config.modelProviders.push({ provider: "knowhow" });
    }

    registerRemote(config, orgId ? { ...remote, orgId } : remote);
    config.activeRemote = remote.name;
    if (orgId) {
      setOrgIdForApi(config, remote.apiUrl, orgId);
    }

    if (identityPath && !isTemporaryIdentityPath(identityPath)) {
      config.cliIdentityPath = path.resolve(identityPath);
    } else if (
      config.cliIdentityPath && isTemporaryIdentityPath(config.cliIdentityPath)
    ) {
      delete config.cliIdentityPath;
    }

    await updateConfig(config);
  } catch (error: unknown) {
    if (http.isHttpError(error) && error.response) {
      const errData = (error as any).body ?? { message: "Unknown error" };
      throw new Error(
        `Error: ${(error as any).status} - ${errData?.message || "Unknown error"}`
      );
    }
    console.log(
      "Error: Unable to fetch user information. Please check your JWT and try again.",
      error
    );
  }
}

export async function loadJwt(remote?: KnowhowRemote): Promise<string> {
  const selectedRemote = remote ??
    findRemoteForApi(await getConfig(), KNOWHOW_API_URL) ??
    createRemote(inferRemoteName(KNOWHOW_API_URL), KNOWHOW_API_URL);
  const jwtFile = resolveJwtPath(selectedRemote.jwtPath);
  const jwt = fs.existsSync(jwtFile) ? fs.readFileSync(jwtFile, "utf8").trim() : "";

  if (!jwt) {
    if (!fs.existsSync(jwtFile)) {
      throw new Error(`Error: JWT file not found: ${jwtFile}`);
    }
    throw new Error("Error: JWT is empty. Re-login with knowhow login --jwt.");
  }

  return jwt;
}

export async function checkJwt(storedJwt: string, apiUrl: string = KNOWHOW_API_URL) {
  const response = await http.get(`${apiUrl}/api/users/me`, {
    headers: {
      Authorization: `Bearer ${storedJwt}`,
    },
  });
  const user = response.data.user;
  const orgs = user.orgs;
  const orgId = response.data.orgId;

  const currentOrg = orgs.find((org: { organizationId: string }) => {
    return org.organizationId === orgId;
  });

  return { user, currentOrg };
}
