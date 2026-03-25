import { Tool } from "../../clients/types";
import { WorkerPasskeyAuthService } from "../auth/WorkerPasskeyAuth";

/**
 * Returns a challenge for the client to sign with their passkey.
 * The challenge must be signed and passed to the `unlock` tool.
 */
export function makeGetChallengeTool(authService: WorkerPasskeyAuthService) {
  async function getChallenge(): Promise<{ challenge: string; message: string }> {
    const challenge = authService.generateChallenge();
    return {
      challenge,
      message:
        "Sign this challenge with your passkey and call the `unlock` tool with the assertion data.",
    };
  }

  const getChallengeDefinition: Tool = {
    type: "function" as const,
    function: {
      name: "getChallenge",
      description:
        "Get a challenge string to sign with your passkey. Required before calling `unlock`. Returns a base64url-encoded challenge.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  };

  return { getChallenge, getChallengeDefinition };
}
