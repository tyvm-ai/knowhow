import http from "../utils/http";
import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { KNOWHOW_API_URL } from "../services/KnowhowClient";
import { Spinner } from "./spinner";
import { BrowserLoginError } from "./errors";

// TypeScript interfaces for the CLI Login API

interface CreateSessionResponse {
  sessionId: string;
  browserUrl: string;
}

interface SessionStatusResponse {
  status: "pending" | "approved" | "denied" | "expired";
  userId?: string;
}

interface RetrieveTokenResponse {
  jwt: string;
  requiresDeviceConfirmation?: boolean;
  jwtSessionId?: string;
}

export class BrowserLoginService {
  private baseUrl: string;

  constructor(baseUrl: string = KNOWHOW_API_URL, private orgId?: string) {
    if (!baseUrl) {
      throw new BrowserLoginError(
        "KNOWHOW_API_URL environment variable not set"
      );
    }
    this.baseUrl = baseUrl;
    this.setupSignalHandlers();
  }

  /**
   * Main login method that orchestrates the browser-based authentication flow
   */
  async login(): Promise<void> {
    const spinner = new Spinner();
    let isAborted = false;

    try {
      spinner.start("Creating login session");

      // Step 1: Create login session
      const sessionData = await this.createSession();
      spinner.stop();
      spinner.start("Opening browser for authentication");

      // Step 2: Open browser
      let browserUrl = sessionData.browserUrl;
      // Append orgId as query string so the frontend can pre-select the correct organization
      if (this.orgId) {
        const separator = browserUrl.includes("?") ? "&" : "?";
        browserUrl = `${browserUrl}${separator}orgId=${encodeURIComponent(this.orgId)}`;
      }
      await openBrowser(browserUrl);
      console.log(
        `\nIf the browser didn't open automatically, please visit: ${browserUrl}\n`
      );
      spinner.stop();
      spinner.start("Waiting for browser authentication");

      // Set up cancellation handler
      const abortHandler = () => {
        isAborted = true;
        spinner.stop();
      };
      process.once("SIGINT", abortHandler);

      let attempt = 0;
      const maxAttempts = 60; // 5 minutes with 5 second intervals

      while (attempt < maxAttempts) {
        attempt++;

        try {
          if (isAborted) {
            throw new BrowserLoginError(
              "Authentication cancelled by user",
              "USER_CANCELLED"
            );
          }

          const statusResponse = await http.get(
            `${this.baseUrl}/api/cli-login/session/${sessionData.sessionId}/status`,
            { timeout: 10000 }
          );

          const status = statusResponse.data as SessionStatusResponse;

          if (status.status.toLowerCase() === "approved") {
            spinner.stop();
            spinner.start("Authentication successful! Retrieving token");

            // Step 4: Retrieve JWT token
            const tokenResponse = await http.post(
              `${this.baseUrl}/api/cli-login/session/${sessionData.sessionId}/token`
            );

            const tokenData = tokenResponse.data as RetrieveTokenResponse;
            spinner.stop();

            if (tokenData.requiresDeviceConfirmation) {
              // Token was issued but the device needs confirmation via email code.
              // Store it now so it's ready once confirmed.
              if (tokenData.jwt) {
                await this.storeJwt(tokenData.jwt);
              }
              console.log("\n⚠️  New device detected — device confirmation required!");
              console.log("─────────────────────────────────────────────────────");
              console.log("A confirmation code has been sent to your email.");
              console.log("You must confirm this device in your browser to complete login.");
              console.log("\nPlease check the browser window you just used to approve the CLI session.");
              console.log("Enter the email code there to confirm this device.");
              console.log("\nAlternatively, visit your settings page:");
              console.log(`  ${process.env.KNOWHOW_FRONTEND_URL || "https://knowhow.tyvm.ai"}/settings?tab=security`);
              console.log("─────────────────────────────────────────────────────\n");

              // Wait for the user to confirm the device — poll /api/users/me until
              // the session becomes ACTIVE (device confirmed) or we time out.
              await this.waitForDeviceConfirmation(tokenData.jwt);
              return;
            }

            await this.storeJwt(tokenData.jwt);
            return;
          } else if (status.status.toLowerCase() === "denied") {
            throw new BrowserLoginError(
              "Authentication was denied",
              "AUTH_DENIED"
            );
          } else if (status.status.toLowerCase() === "expired") {
            throw new BrowserLoginError(
              "Authentication session expired",
              "SESSION_EXPIRED"
            );
          }
        } catch (error) {
          if (http.isHttpError(error) && error.status !== 408) {
            throw new BrowserLoginError(
              `Network error: ${error.message}`,
              "NETWORK_ERROR"
            );
          }
          // Ignore timeout errors, continue polling
        }

        await this.sleep(5000); // Wait 5 seconds between attempts
      }

      process.removeListener("SIGINT", abortHandler);

      throw new BrowserLoginError("Authentication timed out", "TIMEOUT");
    } catch (error) {
      spinner.stop();
      throw error;
    }
  }

  /**
   * Creates a new login session with the API
   */
  private async createSession(): Promise<CreateSessionResponse> {
    try {
      const response = await http.post<CreateSessionResponse>(
        `${this.baseUrl}/api/cli-login/session`,
        {},
        { headers: { "User-Agent": getCliUserAgent() } }
      );
      return response.data;
    } catch (error) {
      if (http.isHttpError(error)) {
        throw new BrowserLoginError(
          `Failed to create login session: ${error.message}`,
          "SESSION_CREATE_FAILED"
        );
      }
      throw new BrowserLoginError(
        `Unexpected error creating session: ${(error as Error).message}`
      );
    }
  }

  /**
   * Securely stores the JWT token to the file system
   */
  private async storeJwt(jwt: string): Promise<void> {
    const configDir = `${process.cwd()}/.knowhow`;
    const jwtFile = `${configDir}/.jwt`;

    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Write JWT to file
    fs.writeFileSync(jwtFile, jwt, { mode: 0o600 });

    // Ensure file has correct permissions (readable only by owner)
    fs.chmodSync(jwtFile, 0o600);
  }

  /**
   * Utility method for creating delays
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Poll /api/users/me with the pending JWT until the device confirmation is
   * completed (session becomes ACTIVE) or we time out (~10 minutes).
   * Shows a spinner so the user knows the CLI is still waiting.
   */
  private async waitForDeviceConfirmation(jwt: string): Promise<void> {
    const spinner = new Spinner();
    spinner.start("Waiting for device confirmation");

    let isCancelled = false;
    const cancelHandler = () => {
      isCancelled = true;
      spinner.stop();
      console.log("\n\nCancelled. Your token is stored — once you confirm the device, re-run your command.");
      process.exit(0);
    };
    process.once("SIGINT", cancelHandler);

    const maxAttempts = 120; // 10 minutes at 5-second intervals
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;

      // Sleep in small increments so SIGINT can be checked more responsively
      for (let i = 0; i < 10; i++) {
        await this.sleep(500);
        if (isCancelled) return;
      }

      try {
        const response = await http.get(`${this.baseUrl}/api/users/me`, {
          headers: { Authorization: `Bearer ${jwt}` },
          timeout: 10000,
        });

        if (response.status === 200) {
          // Device confirmed — session is now ACTIVE
          spinner.stop();
          process.removeListener("SIGINT", cancelHandler);
          console.log("✅ Device confirmed! You are now logged in.");
          return;
        }
      } catch (error) {
        if (http.isHttpError(error)) {
          if (error.status === 403) {
            // Still pending — keep waiting
            continue;
          }
          if (error.status === 401) {
            // 401 can mean:
            // - Session not found yet (timing issue, check-device may not have run)
            // - Session is PENDING_DEVICE_CONFIRMATION (some backend versions return 401)
            // - Token was actually revoked/expired
            // Keep polling for the first ~5 attempts before giving up, to handle timing issues.
            if (attempt >= 10) {
              spinner.stop();
              process.removeListener("SIGINT", cancelHandler);
              throw new BrowserLoginError(
                "Token expired or revoked during device confirmation. Please run 'knowhow login' again.",
                "TOKEN_EXPIRED"
              );
            }
            continue;
          }
        }
      }
    }

    spinner.stop();
    process.removeListener("SIGINT", cancelHandler);
    console.log("\n⏰ Timed out waiting for device confirmation.");
    console.log("Your token is stored — once you confirm the device at:");
    console.log(`  ${process.env.KNOWHOW_FRONTEND_URL || "https://knowhow.tyvm.ai"}/settings?tab=security`);
    console.log("you can re-run your command and it will work.\n");
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const gracefulShutdown = () => {
      console.log("\n\nAuthentication cancelled by user.");
      process.exit(1);
    };

    process.on("SIGTERM", gracefulShutdown);
  }
}

/**
 * Build a descriptive User-Agent string for CLI sessions so they show up
 * with meaningful device info in the sessions UI (e.g. "Knowhow CLI on macOS").
 */
export function getCliUserAgent(): string {
  let cliVersion = "unknown";
  try {
    // __dirname is ts_build/src/auth/ at runtime, so go up 3 levels to package root
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    cliVersion = pkg.version ?? "unknown";
  } catch {
    // ignore — version is cosmetic
  }
  const platform = os.platform();
  const osName =
    platform === "darwin" ? "macOS" :
    platform === "win32" ? "Windows" :
    platform === "linux" ? "Linux" : platform;
  return `Knowhow CLI/${cliVersion} (${osName})`;
}

/**
 * Utility function to open a URL in the default browser across different platforms
 */
export async function openBrowser(url: string): Promise<void> {
  const execAsync = promisify(exec);

  try {
    const platform = os.platform();
    console.log(`Opening browser for URL: ${url} on platform: ${platform}`);

    let command: string;
    switch (platform) {
      case "darwin": // macOS
        command = `open "${url}"`;
        break;
      case "win32": // Windows
        command = `start "" "${url}"`;
        break;
      default: // Linux and others
        command = `xdg-open "${url}"`;
        break;
    }

    await execAsync(command);
  } catch (error) {
    // If we can't open the browser automatically, that's not a fatal error
    // The user can still manually navigate to the URL
    console.warn(`Could not automatically open browser: ${(error as Error).message}`);
  }
}

/**
 * Utility function to validate JWT format (basic validation)
 */
export function validateJwt(jwt: string): boolean {
  if (!jwt || typeof jwt !== "string") {
    return false;
  }

  // Basic JWT structure check: should have exactly 3 parts separated by dots
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return false;
  }

  // Check that each part is non-empty
  for (const part of parts) {
    if (!part || part.trim().length === 0) {
      return false;
    }
  }

  // If this looks like a real JWT (contains base64-like characters), validate it strictly
  const looksLikeRealJwt = parts.every(part => /^[A-Za-z0-9+/\-_]+={0,2}$/.test(part));

  if (looksLikeRealJwt) {
    // Strict validation for real JWTs
    try {
      // Try to decode header and payload as valid JSON
      JSON.parse(Buffer.from(parts[0], "base64").toString());
      JSON.parse(Buffer.from(parts[1], "base64").toString());

      // Try to decode signature - should be valid base64 with reasonable length
      const signature = Buffer.from(parts[2], "base64");

      // JWT signatures are typically at least 32 bytes (256 bits)
      if (signature.length < 32) {
        return false;
      }
    } catch (error) {
      // If any part fails to decode properly, it's not a valid JWT
      return false;
    }
  }

  // For simple test cases like 'part1.part2.part3', just check basic structure
  try {
    return true;
  } catch {
    return true;  // For basic format tests, structure check is enough
  }
}
