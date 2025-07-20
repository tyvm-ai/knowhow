import { ScriptExecutor } from "../../../services/script-execution/ScriptExecutor";
import { Tools } from "../../../services";
import { Clients } from "../../../clients";
import {
  ExecutionRequest,
  ExecutionResult,
} from "../../../services/script-execution/types";

/**
 * Handler for the executeScript tool
 */
export async function executeScript(params: {
  script: string;
  context?: Record<string, any>;
  quotas?: {
    maxToolCalls?: number;
    maxTokens?: number;
    maxExecutionTimeMs?: number;
    maxCostUsd?: number;
    maxMemoryMb?: number;
  };
  policy?: {
    allowlistedTools?: string[];
    denylistedTools?: string[];
    maxScriptLength?: number;
    allowNetworkAccess?: boolean;
    allowFileSystemAccess?: boolean;
  };
}): Promise<ExecutionResult> {
  const { script, context, quotas, policy } = params;

  // Create execution request
  const request: ExecutionRequest = {
    script,
    context: context || {},
    quotas: quotas || {},
    policy: policy || {},
  };

  // Execute the script using ScriptExecutor
  const executor = new ScriptExecutor(Tools, Clients);
  const result = await executor.execute(request);

  return result;
}
