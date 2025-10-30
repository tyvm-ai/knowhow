import axios from "axios";
import fs from "fs";
import path from "path";
import { chmod } from "fs/promises";
import { ask } from "./utils";
import { getConfig, updateConfig } from "./config";
import { KNOWHOW_API_URL } from "./services/KnowhowClient";
import { BrowserLoginService } from "./auth/browserLogin";

export async function login(jwtFlag?: boolean): Promise<void> {
  if (!KNOWHOW_API_URL) {
    throw new Error("Error: KNOWHOW_API_URL environment variable not set.");
  }

  if (jwtFlag) {
    const jwt = await ask("Enter your JWT: ");

    // Update the JWT file
    const configDir = path.join(process.cwd(), ".knowhow");
    const jwtFile = path.join(process.cwd(), ".knowhow", ".jwt");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(jwtFile, jwt);
    fs.chmodSync(jwtFile, 0o600);
    console.log("JWT updated successfully.");
  } else {
    // Use browser login as default method
    console.log("Starting browser-based authentication...");
    try {
      const browserLoginService = new BrowserLoginService();
      await browserLoginService.login();
      console.log("Successfully authenticated via browser!");
    } catch (error) {
      console.error("Browser authentication failed:", error.message);
      console.log("You can try manual JWT login with: knowhow login --jwt");
      throw error;
    }
  }

  // Get current user/org information
  try {
    const storedJwt = await loadJwt();
    await checkJwt(storedJwt);

    const config = await getConfig();
    const proxyUrl = KNOWHOW_API_URL + "/api/proxy";

    if (!config.modelProviders) {
      config.modelProviders = [];
    }

    const hasProvider = config.modelProviders.find(
      (provider) => provider.provider === "knowhow" && provider.url === proxyUrl
    );
    if (!hasProvider) {
      config.modelProviders.push({
        provider: "knowhow",
        url: proxyUrl,
        jwtFile: ".knowhow/.jwt",
      });

      await updateConfig(config);
    }
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(
        `Error: ${error.response.status} - ${
          error.response.data.message || "Unknown error"
        }`
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
  const response = await axios.get(`${KNOWHOW_API_URL}/api/users/me`, {
    headers: {
      Authorization: `Bearer ${storedJwt}`,
    },
  });
  const user = response.data.user;
  const orgs = user.orgs;
  const orgId = response.data.orgId;

  const currentOrg = orgs.find((org) => {
    return org.organizationId === orgId;
  });

  console.log(
    `Current user: ${user.email}, \nOrganization: ${currentOrg?.organization?.name} - ${orgId}`
  );

  return { user, currentOrg };
}
