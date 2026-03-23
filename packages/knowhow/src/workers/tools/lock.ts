import { Tool } from "../../clients/types";
import { WorkerPasskeyAuthService } from "../auth/WorkerPasskeyAuth";

/**
 * Re-locks the worker, requiring passkey authentication again for further tool access.
 */
export function makeLockTool(authService: WorkerPasskeyAuthService) {
  async function lock(): Promise<{ success: boolean; message: string }> {
    authService.lock();
    return {
      success: true,
      message: "Worker locked. Call getChallenge and unlock to regain access.",
    };
  }

  const lockDefinition: Tool = {
    type: "function" as const,
    function: {
      name: "lock",
      description:
        "Lock the worker. After locking, only getChallenge, unlock, and lock tools will be accessible until the worker is unlocked again with a valid passkey assertion.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  };

  return { lock, lockDefinition };
}
