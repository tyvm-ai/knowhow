import axios from "axios";
import { KNOWHOW_API_URL } from "../../services/KnowhowClient";
import { openBrowser } from "../../auth/browserLogin";
import { Spinner } from "../../auth/spinner";
import { getConfig, updateConfig } from "../../config";
import { PasskeySetupSession, PasskeySetupStatus, PasskeyCredential } from "./types";

/**
 * Service that handles the CLI-side passkey setup flow.
 *
 * Flow:
 *  1. POST /api/worker/passkey/setup/session  → get sessionId + browserUrl
 *  2. Open browser to browserUrl
 *  3. Poll /api/worker/passkey/setup/status/:sessionId until status === 'complete'
 *  4. Save the returned credential to local config
 */
export class PasskeySetupService {
  private baseUrl: string;

  constructor(baseUrl: string = KNOWHOW_API_URL) {
    if (!baseUrl) {
      throw new Error("KNOWHOW_API_URL environment variable not set");
    }
    this.baseUrl = baseUrl;
  }

  /**
   * Run the full passkey setup flow.
   */
  async setup(jwt: string): Promise<void> {
    const spinner = new Spinner();

    try {
      spinner.start("Creating passkey setup session");
      const session = await this.createSetupSession(jwt);
      spinner.stop();

      await openBrowser(session.browserUrl);
      console.log(
        `\nIf the browser didn't open automatically, please visit:\n  ${session.browserUrl}\n`
      );

      spinner.start("Waiting for passkey registration in browser…");

      const credential = await this.pollForCompletion(session.sessionId, spinner);

      spinner.stop();
      spinner.start("Saving passkey credential to config");

      await this.saveCredential(credential);

      spinner.stop();
      console.log("✅ Passkey registered successfully!");
      console.log(
        "   Worker will now require passkey authentication for new connections."
      );
    } catch (error) {
      spinner.stop();
      throw error;
    }
  }

  /**
   * Remove passkey requirement from config.
   */
  async reset(): Promise<void> {
    const config = await getConfig();

    if (!config.worker?.auth?.passkey) {
      console.log("ℹ️  No passkey configured for this worker.");
      return;
    }

    const updatedConfig = {
      ...config,
      worker: {
        ...config.worker,
        auth: {
          ...config.worker.auth,
          required: false,
          passkey: undefined,
        },
      },
    };

    await updateConfig(updatedConfig);
    console.log("✅ Passkey requirement removed from config.");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async createSetupSession(jwt: string): Promise<PasskeySetupSession> {
    try {
      const response = await axios.post<PasskeySetupSession>(
        `${this.baseUrl}/api/worker/passkey/setup/session`,
        {},
        {
          headers: { Authorization: `Bearer ${jwt}` },
          timeout: 10000,
        }
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Failed to create passkey setup session: ${
            error.response?.data?.message || error.message
          }`
        );
      }
      throw error;
    }
  }

  private async pollForCompletion(
    sessionId: string,
    spinner: Spinner
  ): Promise<PasskeyCredential> {
    const maxAttempts = 60; // 5 minutes at 5-second intervals
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;

      try {
        const response = await axios.get<PasskeySetupStatus>(
          `${this.baseUrl}/api/worker/passkey/setup/status/${sessionId}`,
          { timeout: 10000 }
        );

        const { status, credential } = response.data;

        if (status === "complete" && credential) {
          return credential;
        } else if (status === "expired") {
          throw new Error(
            "Passkey setup session expired. Please run 'knowhow worker --passkey' again."
          );
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.code === "ECONNABORTED") {
          // Timeout — keep polling
        } else if (!(error instanceof Error && error.message.includes("expired"))) {
          // Re-throw non-timeout, non-expected errors
          throw error;
        } else {
          throw error;
        }
      }

      await this.sleep(5000);
    }

    throw new Error("Passkey setup timed out. Please try again.");
  }

  private async saveCredential(credential: PasskeyCredential): Promise<void> {
    const config = await getConfig();

    const updatedConfig = {
      ...config,
      worker: {
        ...config.worker,
        auth: {
          ...config.worker?.auth,
          required: true,
          passkey: {
            publicKey: credential.publicKey,
            credentialId: credential.credentialId,
            algorithm: credential.algorithm,
          },
          sessionDurationHours: config.worker?.auth?.sessionDurationHours ?? 3,
        },
      },
    };

    await updateConfig(updatedConfig);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
