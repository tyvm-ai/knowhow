import { Tool } from "../../clients/types";
import { WorkerPasskeyAuthService } from "../auth/WorkerPasskeyAuth";

export interface UnlockToolParams {
  /** base64url-encoded signature from WebAuthn assertion */
  signature?: string;
  /** base64url-encoded credential ID */
  credentialId?: string;
  /** base64url-encoded authenticatorData */
  authenticatorData?: string;
  /** base64url-encoded clientDataJSON */
  clientDataJSON?: string;
  /** The challenge that was signed (base64url) */
  challenge?: string;
}

/**
 * Combined challenge+unlock tool.
 *
 * - Called with NO params (or missing assertion fields): generates and returns a challenge.
 * - Called WITH all assertion fields: verifies the WebAuthn assertion and unlocks the worker.
 *
 * This two-step flow lets the frontend call the tool once to get a challenge,
 * do the browser WebAuthn assertion, then call again with the signed data.
 */
export function makeUnlockTool(authService: WorkerPasskeyAuthService) {
  async function unlock(
    params: UnlockToolParams = {}
  ): Promise<{ success: boolean; message: string; challenge?: string; credentialId?: string }> {
    const hasAssertion =
      params.signature &&
      params.credentialId &&
      params.authenticatorData &&
      params.clientDataJSON &&
      params.challenge;

    // Step 1: no assertion data → generate and return a challenge
    if (!hasAssertion) {
      const challenge = authService.generateChallenge();
      return {
        success: false,
        challenge,
        credentialId: authService.getCredentialId(),
        message:
          "Sign this challenge with your passkey and call unlock again with the assertion data.",
      };
    }

    // Step 2: verify assertion and unlock
    const result = await authService.unlock({
      signature: params.signature!,
      credentialId: params.credentialId!,
      authenticatorData: params.authenticatorData!,
      clientDataJSON: params.clientDataJSON!,
      challenge: params.challenge!,
    });

    if (result.success) {
      const info = authService.getSessionInfo();
      return {
        success: true,
        message: `Worker unlocked successfully. Session expires at ${info.expiresAt}.`,
      };
    }

    return {
      success: false,
      message: `Unlock failed: ${result.reason}`,
    };
  }

  const unlockDefinition: Tool = {
    type: "function" as const,
    function: {
      name: "unlock",
      description:
        "Unlock the worker using a passkey. " +
        "Call with NO parameters to receive a challenge string. " +
        "Then sign the challenge via the browser WebAuthn API (navigator.credentials.get) and call again with the assertion data to unlock. " +
        "All other tools are blocked until the worker is unlocked.",
      parameters: {
        type: "object",
        properties: {
          signature: {
            type: "string",
            description:
              "base64url-encoded signature from WebAuthn assertion response.signature",
          },
          credentialId: {
            type: "string",
            description:
              "base64url-encoded credential ID from WebAuthn assertion",
          },
          authenticatorData: {
            type: "string",
            description:
              "base64url-encoded authenticatorData from WebAuthn assertion response.authenticatorData",
          },
          clientDataJSON: {
            type: "string",
            description:
              "base64url-encoded clientDataJSON from WebAuthn assertion response.clientDataJSON",
          },
          challenge: {
            type: "string",
            description:
              "The challenge string returned by the first unlock() call (base64url)",
          },
        },
        required: [],
      },
    },
  };

  return { unlock, unlockDefinition };
}
