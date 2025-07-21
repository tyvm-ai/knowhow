import { ScriptExecutor } from "../../../services/script-execution/ScriptExecutor";
import { ToolsService } from "../../../services/Tools";
import {
  ExecutionRequest,
  ExecutionResult,
} from "../../../services/script-execution/types";
import { services } from "src/services";

export async function executeScript({
  script,
  maxToolCalls,
  maxTokens,
  maxExecutionTimeMs,
  maxCostUsd,
}: {
  script: string;
  maxToolCalls?: number;
  maxTokens?: number;
  maxExecutionTimeMs?: number;
  maxCostUsd?: number;
}) {
  try {
    // Get context from bound ToolsService
    const toolContext =
      this instanceof ToolsService ? this.getContext() : services();
    const clients = toolContext.Clients;

    if (!clients) {
      throw new Error("Clients not available in tool context");
    }

    // Create script executor with access to tools and clients
    const executor = new ScriptExecutor(this, clients);

    // Execute the script
    const result = await executor.execute({
      script,
      quotas: {
        maxToolCalls: maxToolCalls || 50,
        maxTokens: maxTokens || 10000,
        maxExecutionTimeMs: maxExecutionTimeMs || 30000,
        maxCostUsd: maxCostUsd || 1.0,
        maxMemoryMb: 100,
      },
    });

    // If there were policy violations, include them in the response
    const violations = result.trace.events
      .filter((e) => e.type.includes("violation") || e.type.includes("error"))
      .map((e) => e.data);

    // Format the response
    return {
      success: result.success,
      result: result.result,
      error: result.error,
      artifacts: result.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        contentLength: a.content.length,
        createdAt: a.createdAt,
      })),
      consoleOutput: result.consoleOutput,
      metrics: result.trace.metrics,
      violations,
      executionTimeMs: result.trace.endTime - result.trace.startTime,
      quotaUsage: {
        toolCalls: result.trace.metrics.toolCallCount,
        tokens: result.trace.metrics.tokenUsage.total,
        costUsd: result.trace.metrics.costUsd,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: null,
      artifacts: [],
      consoleOutput: [],
      metrics: null,
      violations: [],
      executionTimeMs: 0,
      quotaUsage: {
        toolCalls: 0,
        tokens: 0,
        costUsd: 0,
      },
    };
  }
}
