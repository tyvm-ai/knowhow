/**
 * ScriptRunService — singleton registry for async script runs.
 *
 * Every async run gets a unique runId and is tracked here.  Agent-facing tools
 * (startScript, listScripts, sendScriptMessage, etc.) delegate to this service.
 *
 * The registry is process-local: it lives only as long as the CLI session.
 * Finished runs are retained for TTL_MS (30 min) then pruned on the next
 * `listScripts` call.
 */

import { ChildProcess, fork } from "child_process";
import * as path from "path";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { ScriptTracer } from "./ScriptTracer";
import { ScriptPolicyEnforcer } from "./ScriptPolicy";
import { SandboxContext } from "./SandboxContext";
import {
  ExecutionRequest,
  ExecutionResult,
  ResourceQuotas,
  SecurityPolicy,
} from "./types";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import { AIClient } from "@tyvm/knowhow/ts_build/src/clients";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScriptRunStatus =
  | "starting"
  | "running"
  | "cancelRequested"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut";

export interface ScriptRunEvent {
  runId: string;
  sequence: number;
  id: string;
  timestamp: string;
  type: string;
  channel: "script" | "console" | "trace" | "lifecycle";
  data: unknown;
}

export interface ScriptRunRecord {
  runId: string;
  name?: string;
  status: ScriptRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  ownerTaskId?: string;
  childPid?: number;
  result?: ExecutionResult;
  error?: string;
  /** Bounded ring of events emitted by/for this run */
  events: ScriptRunEvent[];
  nextEventSequence: number;
  /** Number of events dropped due to ring cap */
  droppedEventCount: number;
  /** Pending `waitForMessage` waiters from inside the script */
  _messageWaiters: Array<{
    type?: string;
    afterSequence?: number;
    resolve: (msg: ScriptMessage | null) => void;
    timeoutHandle?: ReturnType<typeof setTimeout>;
  }>;
  /** FIFO of messages sent into the script that haven't been consumed yet */
  _messageQueue: ScriptMessage[];
  /** Next sequence for outbound messages */
  nextInputSequence: number;
  /** Promise that resolves when the run reaches a terminal state */
  _completion: Promise<ExecutionResult>;
  _resolveCompletion: (r: ExecutionResult) => void;
  _rejectCompletion: (e: Error) => void;
  _child?: ChildProcess;
  _tracer?: ScriptTracer;
}

export interface ScriptMessage {
  id: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
  correlationId?: string;
  source?: { taskId?: string; tool?: string };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_RUN = 1000;
const TTL_MS = 30 * 60 * 1000; // 30 min

// ── Service ───────────────────────────────────────────────────────────────────

export class ScriptRunService {
  private runs = new Map<string, ScriptRunRecord>();

  private defaultQuotas: ResourceQuotas = {
    // isolated-vm requires a memory limit; caller-facing usage limits are opt-in.
    maxMemoryMb: 100,
  };

  private defaultPolicy: SecurityPolicy = {
    allowlistedTools: [],
    denylistedTools: ["executeScript", "execCommand", "writeFileChunk", "patchFile"],
    maxScriptLength: 50000,
    allowNetworkAccess: false,
    allowFileSystemAccess: false,
  };

  /**
   * Start a script asynchronously.  Returns the runId immediately; the script
   * runs in a background child worker.
   */
  async start(
    request: ExecutionRequest & { name?: string; ownerTaskId?: string },
    toolsService: ToolsService,
    clients: AIClient
  ): Promise<ScriptRunRecord> {
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;

    let resolveCompletion!: (r: ExecutionResult) => void;
    let rejectCompletion!: (e: Error) => void;
    const completion = new Promise<ExecutionResult>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });

    const record: ScriptRunRecord = {
      runId,
      name: request.name,
      status: "starting",
      createdAt: new Date().toISOString(),
      ownerTaskId: request.ownerTaskId,
      events: [],
      nextEventSequence: 0,
      droppedEventCount: 0,
      _messageWaiters: [],
      _messageQueue: [],
      nextInputSequence: 0,
      _completion: completion,
      _resolveCompletion: resolveCompletion,
      _rejectCompletion: rejectCompletion,
    };

    this.runs.set(runId, record);

    // Launch in background — don't await
    this._launch(record, request, toolsService, clients).catch((err) => {
      this._terminate(record, "failed", null, err instanceof Error ? err.message : String(err));
    });

    return record;
  }

  /** Wait for a run to reach a terminal state */
  async wait(runId: string, timeoutMs?: number): Promise<ExecutionResult> {
    const record = this._get(runId);
    if (timeoutMs !== undefined && timeoutMs > 0) {
      return new Promise<ExecutionResult>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`waitForScript timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        record._completion.then(
          (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          }
        );
      });
    }
    return record._completion;
  }

  /** Send a message into a running script */
  sendMessage(
    runId: string,
    type: string,
    data?: unknown,
    options?: { correlationId?: string; source?: ScriptMessage["source"] }
  ): ScriptMessage {
    const record = this._get(runId);
    if (this._isTerminal(record.status)) {
      throw new Error(`Cannot send message to run ${runId} in status '${record.status}'`);
    }

    const msg: ScriptMessage = {
      id: randomUUID(),
      sequence: record.nextInputSequence++,
      timestamp: new Date().toISOString(),
      type,
      data: data ?? null,
      correlationId: options?.correlationId,
      source: options?.source,
    };

    // Try to deliver to a waiting waiter first
    const waiterIdx = record._messageWaiters.findIndex(
      (w) => !w.type || w.type === type
    );
    if (waiterIdx !== -1) {
      const waiter = record._messageWaiters.splice(waiterIdx, 1)[0];
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      waiter.resolve(msg);
    } else {
      // Queue for the script to consume later
      record._messageQueue.push(msg);
    }

    // Also send over IPC if the worker is alive
    record._child?.send({ type: "script_message", message: msg });

    return msg;
  }

  /** Request cancellation of a run */
  async cancel(runId: string): Promise<void> {
    const record = this._get(runId);
    if (this._isTerminal(record.status)) return;

    record.status = "cancelRequested";
    this._appendEvent(record, "lifecycle", "cancel_requested", {});

    // Cooperative: send cancel message into the script
    record._child?.send({ type: "cancel" });

    // Give 3 s for graceful shutdown then SIGKILL
    const grace = setTimeout(() => {
      if (!this._isTerminal(record.status)) {
        record._child?.kill("SIGKILL");
        this._terminate(record, "cancelled", null, "Cancelled by request");
      }
    }, 3000);

    // Clear grace timer when/if run finishes on its own
    record._completion.finally(() => clearTimeout(grace));
  }

  /** Return the run record (throws if not found) */
  get(runId: string): ScriptRunRecord {
    return this._get(runId);
  }

  /** Return all runs, optionally filtered */
  list(options?: {
    status?: ScriptRunStatus | ScriptRunStatus[];
    includeTerminal?: boolean;
    ownerTaskId?: string;
    limit?: number;
  }): ScriptRunRecord[] {
    this._prune();
    let runs = Array.from(this.runs.values());

    if (options?.ownerTaskId) {
      runs = runs.filter((r) => r.ownerTaskId === options.ownerTaskId);
    }

    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      runs = runs.filter((r) => statuses.includes(r.status));
    } else if (options?.includeTerminal === false) {
      runs = runs.filter((r) => !this._isTerminal(r.status));
    }

    runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (options?.limit && options.limit > 0) {
      runs = runs.slice(0, options.limit);
    }

    return runs;
  }

  /**
   * Long-poll for new events.  Resolves when at least one new event arrives,
   * the run terminates, or timeoutMs elapses.
   */
  async waitForEvents(
    runId: string,
    afterSequence: number,
    timeoutMs: number
  ): Promise<{ events: ScriptRunEvent[]; terminal: boolean; nextSequence: number }> {
    const record = this._get(runId);

    const existing = record.events.filter((e) => e.sequence > afterSequence);
    if (existing.length > 0 || this._isTerminal(record.status)) {
      const next = existing.length > 0 ? existing[existing.length - 1].sequence + 1 : afterSequence;
      return { events: existing, terminal: this._isTerminal(record.status), nextSequence: next };
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const evs = record.events.filter((e) => e.sequence > afterSequence);
        const next = evs.length > 0 ? evs[evs.length - 1].sequence + 1 : afterSequence;
        resolve({ events: evs, terminal: this._isTerminal(record.status), nextSequence: next });
      };

      const timer = setTimeout(settle, timeoutMs);

      // Watch for new events via completion (simplified: poll on completion)
      record._completion.finally(settle);

      // Subscribe to new event notifications via a one-shot listener stored on the record
      (record as any)._eventWaiters = (record as any)._eventWaiters || [];
      (record as any)._eventWaiters.push(settle);
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async _launch(
    record: ScriptRunRecord,
    request: ExecutionRequest & { name?: string; ownerTaskId?: string },
    toolsService: ToolsService,
    clients: AIClient
  ): Promise<void> {
    const quotas = { ...this.defaultQuotas, ...request.quotas };
    const policy = { ...this.defaultPolicy, ...request.policy };
    const policyEnforcer = new ScriptPolicyEnforcer(quotas, policy);
    const tracer = new ScriptTracer();
    record._tracer = tracer;

    // Collect tool names
    let availableTools: string[] = [];
    try {
      const ctx = new SandboxContext(toolsService, clients, tracer, policyEnforcer);
      availableTools = ctx.listToolNames();
    } catch { /* ignore */ }

    record.status = "running";
    record.startedAt = new Date().toISOString();
    this._appendEvent(record, "lifecycle", "started", { quotas });

    const workerJs = path.join(__dirname, "script-worker.js");

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const child = fork(workerJs, [], {
        execArgv: ["--no-node-snapshot", "--enable-source-maps"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      child.stderr?.pipe(process.stderr);
      record._child = child;
      record.childPid = child.pid;

      // Runs are unbounded unless the caller intentionally supplies a deadline.
      const timeoutMs = quotas.maxExecutionTimeMs;
      const globalTimeout = timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            if (!this._isTerminal(record.status)) {
              child.kill("SIGKILL");
              this._terminate(record, "timedOut", null, `Execution timed out after ${timeoutMs}ms`);
            }
          }, timeoutMs)
        : undefined;

      const finish = (result: ExecutionResult) => {
        if (globalTimeout) clearTimeout(globalTimeout);
        this._terminate(record, result.success ? "completed" : "failed", result, result.error ?? undefined);
        // The worker keeps an IPC message listener for the lifetime of a run.
        // Close that channel after its terminal message so the child can exit
        // and completed runs do not retain subprocesses.
        if (child.connected) child.disconnect();
        resolveSpawn();
      };

      child.on("message", async (msg: any) => {
        if (msg.type === "ready") {
          child.send({
            type: "run",
            script: request.script,
            args: request.args ?? {},
            quotas,
            policy,
            availableTools,
          });
        } else if (msg.type === "event") {
          const ev = msg.event as { type: string; data?: any };
          // Route to appropriate channel
          const channel: ScriptRunEvent["channel"] = ev.type.startsWith("console_")
            ? "console"
            : ev.type === "script_event"
            ? "script"
            : "trace";
          this._appendEvent(record, channel, ev.type, ev.data ?? {});
          request.onEvent?.(ev as any);
        } else if (msg.type === "script_event") {
          // Explicit emit() from script
          this._appendEvent(record, "script", msg.eventType ?? "emit", msg.data ?? {});
          this._wakeEventWaiters(record);
        } else if (msg.type === "wait_for_message") {
          // Script is waiting for a message — deliver from queue or register waiter
          this._handleWaitForMessage(record, msg, child);
        } else if (msg.type === "tool_call") {
          try {
            policyEnforcer.recordToolCall();
            const isAgentStart = msg.toolName === "startAgentTask" || msg.toolName === "agentCall";
            if (isAgentStart) {
              this._appendEvent(record, "lifecycle", "agent_start_requested", {
                toolName: msg.toolName,
                requestedTaskId: msg.params?.taskId ?? null,
                agentName: msg.params?.agentName ?? msg.params?.agent ?? null,
              });
            }
            const toolCall = {
              id: `async-run-tool-${Date.now()}`,
              type: "function" as const,
              function: { name: msg.toolName, arguments: JSON.stringify(msg.params ?? {}) },
            };
            const rawResult = await toolsService.callTool(
              toolCall,
              toolsService.getFunctionNames(),
              {
                taskId: record.ownerTaskId,
              }
            );
            const result =
              rawResult && typeof rawResult === "object" && "functionResp" in rawResult
                ? (rawResult as any).functionResp
                : rawResult;
            child.send({ type: "tool_result", id: msg.id, result: result ?? null });

            // ── Emit agent_started event when startAgentTask is called ────────
            // This lets the outer agent see child taskIds via getScriptEvents
            // without needing to instrument the script itself.
            if (isAgentStart) {
              const taskId = result && typeof result === "object"
                ? (result as any).taskId ?? (result as any).id ?? null
                : null;
              if (taskId) {
                const details = {
                  toolName: msg.toolName,
                  taskId,
                  status: (result as any)?.status ?? "started",
                  pid: (result as any)?.pid ?? null,
                  syncFs: (result as any)?.syncFs ?? null,
                  syncReady: (result as any)?.syncReady ?? null,
                  agentDir: (result as any)?.agentDir ?? null,
                  logPath: (result as any)?.logPath ?? null,
                  parentTaskId: (result as any)?.parentTaskId ?? record.ownerTaskId ?? null,
                  agentName: msg.params?.agentName ?? msg.params?.agent ?? null,
                  prompt: typeof msg.params?.prompt === "string" ? msg.params.prompt.slice(0, 200) : null,
                };
                const started = (result as any)?.success !== false;
                if (started) {
                  this._appendEvent(record, "lifecycle", "agent_spawned", details);
                  if (details.syncFs) {
                    this._appendEvent(
                      record,
                      "lifecycle",
                      details.syncReady ? "agent_sync_ready" : "agent_sync_pending",
                      details
                    );
                  }
                  // Compatibility event for existing script observers.
                  this._appendEvent(record, "lifecycle", "agent_started", details);
                  if (details.agentDir) this._monitorAgent(record, details);
                } else {
                  this._appendEvent(record, "lifecycle", "agent_start_failed", {
                    ...details,
                    error: (result as any)?.error ?? null,
                  });
                }
              } else {
                this._appendEvent(record, "lifecycle", "agent_start_failed", {
                  toolName: msg.toolName,
                  error: (result as any)?.error ?? "Agent tool returned no taskId",
                });
              }
            }
          } catch (err: any) {
            if (msg.toolName === "startAgentTask" || msg.toolName === "agentCall") {
              this._appendEvent(record, "lifecycle", "agent_start_failed", {
                toolName: msg.toolName,
                requestedTaskId: msg.params?.taskId ?? null,
                error: err?.message ?? String(err),
              });
            }
            child.send({ type: "tool_result", id: msg.id, result: null, error: err?.message ?? String(err) });
          }
        } else if (msg.type === "llm_call") {
          try {
            const result = await clients.createCompletion("", {
              messages: msg.messages,
              model: msg.options?.model,
              max_tokens: msg.options?.maxTokens,
            });
            child.send({ type: "llm_result", id: msg.id, result: result ?? null });
          } catch (err: any) {
            child.send({ type: "llm_result", id: msg.id, result: null, error: err?.message ?? String(err) });
          }
        } else if (msg.type === "agent_call") {
          try {
            const toolCall = {
              id: `async-run-agent-${Date.now()}`,
              type: "function" as const,
              function: {
                name: "agentCall",
                arguments: JSON.stringify({ agentName: msg.agentName, query: msg.query }),
              },
            };
            const rawResult = await toolsService.callTool(
              toolCall,
              toolsService.getFunctionNames(),
              {
                taskId: record.ownerTaskId,
              }
            );
            const result =
              rawResult && typeof rawResult === "object" && "functionResp" in rawResult
                ? (rawResult as any).functionResp
                : rawResult;
            child.send({ type: "agent_result", id: msg.id, result: result ?? null });
          } catch (err: any) {
            child.send({ type: "agent_result", id: msg.id, result: null, error: err?.message ?? String(err) });
          }
        } else if (msg.type === "done") {
          finish({
            success: true,
            error: null,
            result: msg.result,
            trace: tracer.getTrace(),
            artifacts: Array.isArray(msg.artifacts) ? msg.artifacts : [],
            consoleOutput: [],
          });
        } else if (msg.type === "error") {
          finish({
            success: false,
            error: msg.error,
            result: null,
            trace: tracer.getTrace(),
            artifacts: [],
            consoleOutput: [],
          });
        }
      });

      child.on("error", (err) => {
        if (globalTimeout) clearTimeout(globalTimeout);
        this._terminate(record, "failed", null, err.message);
        rejectSpawn(err);
      });

      child.on("exit", (code) => {
        if (globalTimeout) clearTimeout(globalTimeout);
        if (!this._isTerminal(record.status) && code !== 0 && code !== null) {
          this._terminate(record, "failed", null, `Worker exited with code ${code}`);
          resolveSpawn();
        }
      });
    });
  }

  /** Relay bounded, change-only child status snapshots into lifecycle events. */
  private _monitorAgent(
    record: ScriptRunRecord,
    details: { taskId: string; agentDir: string; syncReady?: boolean }
  ): void {
    let lastSnapshot = "";
    let lastProgressSignature = "";
    let missingReads = 0;
    let syncReadyEmitted = details.syncReady === true;
    const poll = async () => {
      try {
        const [statusText, metadataText] = await Promise.all([
          fs.readFile(path.join(details.agentDir, "status.txt"), "utf8"),
          fs.readFile(path.join(details.agentDir, "metadata.json"), "utf8"),
        ]);
        missingReads = 0;
        if (!syncReadyEmitted) {
          syncReadyEmitted = true;
          this._appendEvent(record, "lifecycle", "agent_sync_ready", {
            taskId: details.taskId,
            agentDir: details.agentDir,
          });
        }
        const metadata = JSON.parse(metadataText);
        const status = statusText.trim() || metadata.status || "unknown";
        const snapshot = {
          taskId: details.taskId,
          status,
          costUsd: metadata.totalCostUsd ?? null,
          tokenUsage: metadata.tokenUsage ?? null,
          threadCount: Array.isArray(metadata.threads) ? metadata.threads.length : null,
          updatedAt: metadata.updatedAt ?? metadata.lastUpdate ?? null,
        };

        // replyToParent normally targets the script owner's agent. Mirror the
        // latest structured progress update into this run's observable stream
        // so a detached script can be monitored without attaching to the child.
        const messages = Array.isArray(metadata.threads)
          ? metadata.threads.flatMap((thread: any) => Array.isArray(thread) ? thread : [])
          : [];
        const progressCalls = messages.flatMap((message: any) =>
          message?.role === "assistant" && Array.isArray(message.tool_calls)
            ? message.tool_calls.filter((call: any) => call?.function?.name === "replyToParent")
            : []
        );
        const progressCall = progressCalls[progressCalls.length - 1];
        if (progressCall) {
          const rawArgs = progressCall.function?.arguments;
          let progress: any = rawArgs;
          try {
            progress = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
          } catch { /* retain malformed arguments for diagnostics */ }
          const text = typeof progress?.message === "string" ? progress.message : String(progress ?? "");
          const progressSignature = `${progressCall.id ?? ""}:${text}`;
          if (text && progressSignature !== lastProgressSignature) {
            lastProgressSignature = progressSignature;
            this._appendEvent(record, "lifecycle", "agent_progress", {
              taskId: details.taskId,
              message: text.slice(0, 4000),
              truncated: text.length > 4000,
            });
          }
        }
        const signature = JSON.stringify(snapshot);
        if (signature !== lastSnapshot) {
          lastSnapshot = signature;
          const terminal = ["completed", "failed", "cancelled", "error"].includes(status);
          this._appendEvent(
            record,
            "lifecycle",
            terminal ? (status === "completed" ? "agent_completed" : "agent_failed") : "agent_status",
            snapshot
          );
          if (terminal) return;
        }
      } catch {
        // Startup acknowledgement can precede the directory on a slow host.
        // Stop eventually rather than retaining an orphaned timer forever.
        missingReads++;
        if (missingReads >= 30) {
          this._appendEvent(record, "lifecycle", "agent_status_unavailable", {
            taskId: details.taskId,
            agentDir: details.agentDir,
          });
          return;
        }
      }
      setTimeout(poll, 1000).unref?.();
    };
    void poll();
  }

  private _handleWaitForMessage(
    record: ScriptRunRecord,
    msg: { id: string; messageType?: string; afterSequence?: number; timeoutMs?: number },
    child: ChildProcess
  ) {
    const { id, messageType, afterSequence, timeoutMs } = msg;

    // Check queue first
    const idx = record._messageQueue.findIndex(
      (m) => (!messageType || m.type === messageType) &&
             (afterSequence === undefined || m.sequence > afterSequence)
    );
    if (idx !== -1) {
      const found = record._messageQueue.splice(idx, 1)[0];
      child.send({ type: "wait_for_message_result", id, message: found });
      return;
    }

    // Register waiter
    const waiter = {
      type: messageType,
      afterSequence,
      resolve: (message: ScriptMessage | null) => {
        child.send({ type: "wait_for_message_result", id, message });
      },
      timeoutHandle: undefined as ReturnType<typeof setTimeout> | undefined,
    };

    if (timeoutMs && timeoutMs > 0) {
      waiter.timeoutHandle = setTimeout(() => {
        const i = record._messageWaiters.indexOf(waiter);
        if (i !== -1) record._messageWaiters.splice(i, 1);
        child.send({ type: "wait_for_message_result", id, message: null });
      }, timeoutMs);
    }

    record._messageWaiters.push(waiter);
  }

  private _terminate(
    record: ScriptRunRecord,
    status: ScriptRunStatus,
    result: ExecutionResult | null,
    error?: string
  ) {
    if (this._isTerminal(record.status)) return;
    record.status = status;
    record.finishedAt = new Date().toISOString();
    record.error = error;

    if (result) {
      record.result = result;
      record._resolveCompletion(result);
    } else {
      const syntheticResult: ExecutionResult = {
        success: false,
        error: error ?? "Unknown error",
        result: null,
        trace: record._tracer?.getTrace() ?? ({} as any),
        artifacts: [],
        consoleOutput: [],
      };
      record.result = syntheticResult;
      if (status === "completed") {
        record._resolveCompletion(syntheticResult);
      } else {
        record._resolveCompletion(syntheticResult);
      }
    }

    this._appendEvent(record, "lifecycle", `run_${status}`, { error });
    this._wakeEventWaiters(record);

    // Resolve all pending message waiters with null (run ended)
    for (const waiter of record._messageWaiters) {
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      waiter.resolve(null);
    }
    record._messageWaiters = [];

    // Kill child if still running
    if (record._child && !record._child.killed) {
      try { record._child.kill(); } catch { /* ignore */ }
    }
  }

  private _appendEvent(
    record: ScriptRunRecord,
    channel: ScriptRunEvent["channel"],
    type: string,
    data: unknown
  ) {
    if (record.events.length >= MAX_EVENTS_PER_RUN) {
      record.events.shift();
      record.droppedEventCount++;
    }
    record.events.push({
      runId: record.runId,
      sequence: record.nextEventSequence++,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      channel,
      data,
    });
    this._wakeEventWaiters(record);
  }

  private _wakeEventWaiters(record: ScriptRunRecord) {
    const waiters: Array<() => void> = (record as any)._eventWaiters ?? [];
    (record as any)._eventWaiters = [];
    for (const w of waiters) {
      try { w(); } catch { /* ignore */ }
    }
  }

  private _get(runId: string): ScriptRunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Script run '${runId}' not found`);
    return record;
  }

  private _isTerminal(status: ScriptRunStatus): boolean {
    return ["completed", "failed", "cancelled", "timedOut"].includes(status);
  }

  private _prune() {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, record] of this.runs) {
      if (
        this._isTerminal(record.status) &&
        record.finishedAt &&
        new Date(record.finishedAt).getTime() < cutoff
      ) {
        this.runs.delete(id);
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ScriptRunService | null = null;

export function getScriptRunService(): ScriptRunService {
  if (!_instance) _instance = new ScriptRunService();
  return _instance;
}
