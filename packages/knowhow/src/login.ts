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
export async function login(jwtFlag?: boolean, identityPath?: string): Promise<void> {
  if (!KNOWHOW_API_URL) {
    throw new Error("Error: KNOWHOW_API_URL environment variable not set.");
  }

  if (jwtFlag) {
    const jwt = await ask("Enter your JWT: ");

    const configDir = path.join(process.cwd(), ".knowhow");
    const jwtFile = path.join(configDir, ".jwt");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(jwtFile, jwt);
    fs.chmodSync(jwtFile, 0o600);
    console.log("JWT updated successfully.");
  } else {
    const selectedIdentityPath = identityPath ?? getDefaultPrivateKeyPath();
    const config = await getConfig();
    const orgId = config.orgId;

    // A local key is not proof of registration. Let the selected environment
    // check it, but only when an organization is available to bind the attempt.
    if (orgId && hasKeyPair(selectedIdentityPath)) {
      console.log("Found CLI identity — authenticating with public key...");
      try {
        const success = await authenticateWithKey(orgId, KNOWHOW_API_URL, selectedIdentityPath);
        if (success) {
          console.log("✅ Successfully authenticated via public key!");
          return await postLoginConfigUpdate(selectedIdentityPath);
        }
        console.warn("Key authentication returned no JWT, falling back to browser login...");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Key authentication failed (${message}), falling back to browser login...`);
      }
    }

    // Fall back when no org/key is configured or when key auth is unavailable.
    await doBrowserLogin(selectedIdentityPath);
    identityPath = selectedIdentityPath;
  }

  await postLoginConfigUpdate(identityPath);
}

/** Complete browser PKCE, then best-effort bootstrap the selected identity. */
async function doBrowserLogin(identityPath?: string): Promise<void> {
  console.log("Starting browser-based authentication...");
  try {
    const existingConfig = await getConfig();
    const existingOrgId = existingConfig?.orgId;
    const browserLoginService = new BrowserLoginService(undefined, existingOrgId);
    await browserLoginService.login();
    console.log("✅ Successfully authenticated via browser!");

    try {
      const keyPair = getOrCreatePublicKey(identityPath);
      await registerPublicKey(
        await loadJwt(),
        keyPair.publicKeyBase64,
        KNOWHOW_API_URL
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
async function postLoginConfigUpdate(identityPath?: string): Promise<void> {
  try {
    const storedJwt = await loadJwt();
    const { user, currentOrg } = await checkJwt(storedJwt);
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

    if (orgId) {
      config.orgId = orgId;
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

export async function loadJwt(): Promise<string> {
  const jwtFile = path.join(process.cwd(), ".knowhow", ".jwt");
  if (!fs.existsSync(jwtFile)) {
    throw new Error("Error: JWT file not found.");
  }

  const jwt = fs.readFileSync(jwtFile, "utf-8").trim();

  if (!jwt) {
    throw new Error("Error: JWT is empty. Re-login with knowhow login --jwt.");
  }

  return jwt;
}

export async function checkJwt(storedJwt: string) {
  const response = await http.get(`${KNOWHOW_API_URL}/api/users/me`, {
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
