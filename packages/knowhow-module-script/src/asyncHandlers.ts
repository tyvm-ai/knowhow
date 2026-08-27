/**
 * asyncHandlers.ts
 *
 * Tool handlers for the async script run API:
 *   startScript, listScripts, getScriptRun, getScriptEvents,
 *   sendScriptMessage, waitForScript, cancelScript, waitForScriptEvents
 */

import { promises as fs } from "fs";
import * as path from "path";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import { services } from "@tyvm/knowhow/ts_build/src/services";
import { getScriptRunService, ScriptRunRecord, ScriptRunStatus } from "./ScriptRunService";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getContext(toolService: ToolsService | void) {
  // Preserve the invoking agent's tool service. It contains tools explicitly
  // enabled for that agent, which may not exist in the process-wide singleton.
  // Falling back to the singleton is only appropriate for unbound/direct calls.
  const sessionTools = services().Tools as ToolsService;
  const boundTools = toolService instanceof ToolsService ? toolService : undefined;
  const Tools = boundTools?.getToolNames?.().length ? boundTools : sessionTools;
  if (!Tools) throw new Error("Tools not available in tool context");
  const ctx = Tools.getContext();
  if (!ctx?.Clients) throw new Error("Clients not available in tool context");
  return { Tools, Clients: ctx.Clients };
}

function summarizeRun(record: ScriptRunRecord) {
  return {
    runId: record.runId,
    name: record.name ?? null,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    ownerTaskId: record.ownerTaskId ?? null,
    childPid: record.childPid ?? null,
    lastEventSequence: record.nextEventSequence - 1,
    droppedEventCount: record.droppedEventCount,
    error: record.error ?? null,
  };
}

// ── startScript ───────────────────────────────────────────────────────────────

export async function startScript(
  this: ToolsService | void,
  {
    script,
    name,
    args,
    maxToolCalls,
    maxTokens,
    maxExecutionTimeMs,
    maxCostUsd,
    allowNetworkAccess,
    parentTaskId,
    _ctx,
  }: {
    script: string;
    name?: string;
    args?: Record<string, unknown>;
    maxToolCalls?: number;
    maxTokens?: number;
    maxExecutionTimeMs?: number;
    maxCostUsd?: number;
    allowNetworkAccess?: boolean;
    parentTaskId?: string;
    _ctx?: { taskId?: string };
  }
) {
  try {
    const { Tools, Clients } = getContext(this);
    const svc = getScriptRunService();

    // Explicit ownership wins; otherwise inherit the invoking agent's
    // per-tool-call context. ToolContext itself intentionally has no taskId.
    const ownerTaskId = parentTaskId ?? _ctx?.taskId;

    const record = await svc.start(
      {
        script,
        name,
        args,
        ownerTaskId,
        quotas: {
          maxToolCalls,
          maxTokens,
          maxExecutionTimeMs,
          maxCostUsd,
          maxMemoryMb: 100,
        },
        policy: {
          allowNetworkAccess: allowNetworkAccess ?? false,
        },
      },
      Tools,
      Clients
    );

    return {
      success: true,
      runId: record.runId,
      name: record.name ?? null,
      status: record.status,
      createdAt: record.createdAt,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      runId: null,
    };
  }
}

// ── startScriptFile ──────────────────────────────────────────────────────────

/**
 * Host-side file entry point for async scripts. Reading the source before the
 * worker starts avoids unsupported import/require/eval wrappers in the isolate.
 */
export async function startScriptFile(
  this: ToolsService | void,
  {
    inputFile,
    name,
    args,
    maxToolCalls,
    maxTokens,
    maxExecutionTimeMs,
    maxCostUsd,
    allowNetworkAccess,
    parentTaskId,
    _ctx,
  }: {
    inputFile: string;
    name?: string;
    args?: Record<string, unknown>;
    maxToolCalls?: number;
    maxTokens?: number;
    maxExecutionTimeMs?: number;
    maxCostUsd?: number;
    allowNetworkAccess?: boolean;
    parentTaskId?: string;
    _ctx?: { taskId?: string };
  }
) {
  try {
    const scriptPath = path.resolve(inputFile);
    const stat = await fs.stat(scriptPath);
    if (!stat.isFile()) {
      throw new Error(`Script path is not a file: ${scriptPath}`);
    }

    const script = await fs.readFile(scriptPath, "utf-8");
    const result = await startScript.call(this, {
      script,
      name: name ?? path.basename(scriptPath),
      args,
      maxToolCalls,
      maxTokens,
      maxExecutionTimeMs,
      maxCostUsd,
      allowNetworkAccess,
      parentTaskId,
      _ctx,
    });

    return { ...result, inputFile: scriptPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      runId: null,
      inputFile: path.resolve(inputFile),
    };
  }
}

// ── listScripts ───────────────────────────────────────────────────────────────

export async function listScripts(
  this: ToolsService | void,
  {
    status,
    includeTerminal,
    limit,
  }: {
    status?: ScriptRunStatus | ScriptRunStatus[];
    includeTerminal?: boolean;
    limit?: number;
  } = {}
) {
  try {
    const svc = getScriptRunService();
    const runs = svc.list({ status, includeTerminal, limit });
    return {
      success: true,
      runs: runs.map(summarizeRun),
      total: runs.length,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      runs: [],
      total: 0,
    };
  }
}

// ── getScriptRun ──────────────────────────────────────────────────────────────

export async function getScriptRun(
  this: ToolsService | void,
  { runId }: { runId: string }
) {
  try {
    const svc = getScriptRunService();
    const record = svc.get(runId);
    return {
      success: true,
      run: {
        ...summarizeRun(record),
        result: record.result
          ? {
              success: record.result.success,
              error: record.result.error,
              result: record.result.result,
              quotaUsage: record.result.trace?.metrics
                ? {
                    toolCalls: record.result.trace.metrics.toolCallCount,
                    tokens: record.result.trace.metrics.tokenUsage?.total ?? 0,
                    costUsd: record.result.trace.metrics.costUsd,
                  }
                : null,
            }
          : null,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      run: null,
    };
  }
}

// ── getScriptEvents ───────────────────────────────────────────────────────────

export async function getScriptEvents(
  this: ToolsService | void,
  {
    runId,
    afterSequence,
    channels,
    limit,
  }: {
    runId: string;
    afterSequence?: number;
    channels?: string[];
    limit?: number;
  }
) {
  try {
    const svc = getScriptRunService();
    const record = svc.get(runId);

    let events = record.events.filter(
      (e) => e.sequence > (afterSequence ?? -1)
    );

    if (channels && channels.length > 0) {
      events = events.filter((e) => channels.includes(e.channel));
    }

    if (limit && limit > 0) {
      events = events.slice(0, limit);
    }

    const nextSequence =
      events.length > 0 ? events[events.length - 1].sequence + 1 : (afterSequence ?? 0);

    return {
      success: true,
      events,
      nextSequence,
      droppedBeforeSequence: record.droppedEventCount > 0 ? record.droppedEventCount : undefined,
      terminal: ["completed", "failed", "cancelled", "timedOut"].includes(record.status),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      events: [],
      nextSequence: 0,
      terminal: false,
    };
  }
}

// ── waitForScriptEvents ───────────────────────────────────────────────────────

export async function waitForScriptEvents(
  this: ToolsService | void,
  {
    runId,
    afterSequence,
    timeoutMs,
    channels,
  }: {
    runId: string;
    afterSequence?: number;
    timeoutMs?: number;
    channels?: string[];
  }
) {
  try {
    const svc = getScriptRunService();
    const { events, terminal, nextSequence } = await svc.waitForEvents(
      runId,
      afterSequence ?? -1,
      timeoutMs ?? 30000
    );

    let filtered = events;
    if (channels && channels.length > 0) {
      filtered = events.filter((e) => channels.includes(e.channel));
    }

    return {
      success: true,
      events: filtered,
      nextSequence,
      terminal,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      events: [],
      nextSequence: 0,
      terminal: false,
    };
  }
}

// ── sendScriptMessage ─────────────────────────────────────────────────────────

export async function sendScriptMessage(
  this: ToolsService | void,
  {
    runId,
    type,
    data,
    correlationId,
  }: {
    runId: string;
    type: string;
    data?: unknown;
    correlationId?: string;
  }
) {
  try {
    const svc = getScriptRunService();
    const msg = svc.sendMessage(runId, type, data, { correlationId });
    return {
      success: true,
      accepted: true,
      messageId: msg.id,
      sequence: msg.sequence,
    };
  } catch (error) {
    return {
      success: false,
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── waitForScript ─────────────────────────────────────────────────────────────

export async function waitForScript(
  this: ToolsService | void,
  {
    runId,
    timeoutMs,
  }: {
    runId: string;
    timeoutMs?: number;
  }
) {
  try {
    const svc = getScriptRunService();
    const result = await svc.wait(runId, timeoutMs);
    const record = svc.get(runId);
    return {
      success: true,
      runId,
      status: record.status,
      result: result.result,
      error: result.error,
      executionResult: {
        success: result.success,
        error: result.error,
        result: result.result,
        artifacts: result.artifacts?.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          contentLength: a.content?.length ?? 0,
          createdAt: a.createdAt,
        })),
        consoleOutput: result.consoleOutput,
        metrics: result.trace?.metrics ?? null,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      runId,
      status: "unknown" as any,
      result: null,
    };
  }
}

// ── cancelScript ──────────────────────────────────────────────────────────────

export async function cancelScript(
  this: ToolsService | void,
  { runId }: { runId: string }
) {
  try {
    const svc = getScriptRunService();
    await svc.cancel(runId);
    const record = svc.get(runId);
    return {
      success: true,
      runId,
      status: record.status,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      runId,
    };
  }
}
