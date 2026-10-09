/**
 * ScriptRunService — starts, resumes and finds script runs.
 *
 * Each run is a `ScriptRun` (a StatefulProcess) persisted under
 * `.knowhow/processes/scripts/<runId>/` (see ScriptRunStore). This service
 * keeps the runs THIS process owns (`live`) and reads everything else from
 * disk, so listing, events, pause/cancel/messages and resume work across
 * terminals and after the owning CLI has exited.
 *
 * Runs owned here are pruned from memory TTL_MS after finishing; their
 * directories stay (`knowhow processes cleanup` removes old ones).
 */

import { fork } from "child_process";
import * as path from "path";
import { promises as fs } from "fs";
import { ScriptTracer } from "./ScriptTracer";
import { ScriptPolicyEnforcer } from "./ScriptPolicy";
import { SandboxContext } from "./SandboxContext";
import { createHostBridge } from "./hostBridge";
import {
  ExecutionRequest,
  ExecutionResult,
  ResourceQuotas,
  SecurityPolicy,
} from "./types";
import {
  ScriptMessage,
  ScriptRun,
  ScriptRunEvent,
  ScriptRunRecord,
  ScriptRunStatus,
  isTerminalScriptStatus,
} from "./ScriptRun";
import { PersistedScriptRun, ScriptRunStore } from "./ScriptRunStore";
import type { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import type { AIClient } from "@tyvm/knowhow/ts_build/src/clients";

export * from "./ScriptRun";

const TTL_MS = 30 * 60 * 1000; // 30 min (in-memory only)
const AGENT_START_TOOLS = new Set(["startAgentTask", "agentCall"]);

export type StartScriptRequest = ExecutionRequest & {
  name?: string;
  ownerTaskId?: string;
  /** file the script came from (informational; the text is persisted) */
  sourcePath?: string;
  /** initial scriptState (e.g. seeded by the caller) */
  scriptState?: Record<string, unknown>;
};

export interface ScriptRunServiceOptions {
  store?: ScriptRunStore;
  /** write runs to disk (default true; tests may turn it off) */
  persist?: boolean;
}

export type ResumeOutcome =
  /** a live run in this process was paused: it was unpaused */
  | { mode: "unpaused"; run: ScriptRunRecord }
  /** owned by another live process: control.json now says running */
  | { mode: "signalled"; run: ScriptRunRecord }
  /** restarted here from its persisted scriptState */
  | { mode: "restarted"; run: ScriptRun };

export class ScriptRunService {
  private live = new Map<string, ScriptRun>();
  readonly store: ScriptRunStore;
  private persist: boolean;

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

  constructor(opts: ScriptRunServiceOptions = {}) {
    this.store = opts.store ?? new ScriptRunStore();
    this.persist = opts.persist ?? true;
  }

  // ── start / resume ──────────────────────────────────────────────────────────

  /** Start a script in a background worker. Returns as soon as it is registered. */
  async start(
    request: StartScriptRequest,
    toolsService: ToolsService,
    clients: AIClient
  ): Promise<ScriptRun> {
    const run = ScriptRun.create({
      name: request.name,
      ownerTaskId: request.ownerTaskId,
      source: { path: request.sourcePath, length: request.script.length },
      args: request.args ?? {},
      quotas: request.quotas,
      policy: request.policy,
      scriptState: request.scriptState,
    });
    if (this.persist) this.store.writeSource(run.runId, request.script);
    return this.launch(run, request, toolsService, clients);
  }

  /**
   * Resume a run:
   *  - paused here -> unpause;
   *  - running in another live process -> ask it (control.json);
   *  - otherwise (finished, failed, cancelled, orphaned) -> start the same
   *    script again here, with its persisted scriptState and
   *    `runInfo.resumed === true`. Completed runs need `force`.
   */
  async resume(
    runId: string,
    toolsService: ToolsService,
    clients: AIClient,
    opts: { force?: boolean; onEvent?: ExecutionRequest["onEvent"] } = {}
  ): Promise<ResumeOutcome> {
    const own = this.live.get(runId) ?? this.live.get(this.store.resolve(runId).runId);
    if (own && !own.isTerminal()) {
      own.resume();
      return { mode: "unpaused", run: own };
    }
    let document;
    if (own) {
      // finished here: our in-memory document is the newest one
      await own.close();
      document = own.snapshot();
    } else {
      const persisted = this.store.resolve(runId);
      if (!isTerminalScriptStatus(persisted.status) && !persisted.orphaned) {
        await this.store.channel(persisted.runId).writeControl({ desired: "running" });
        return { mode: "signalled", run: persisted };
      }
      document = persisted.document;
    }
    const id = document.state.runId;
    if (document.state.status === "completed" && !opts.force) {
      throw new Error(`Run ${id} already completed; pass force to run it again`);
    }
    const script = this.store.readSource(id);
    // a stale "cancelled"/"paused" in control.json must not stop the new attempt
    await this.store.channel(id).writeControl({ desired: "running" });
    const run = ScriptRun.fromDocument(document);
    const state = run.getState();
    await this.launch(
      run,
      {
        script,
        args: state.args,
        quotas: state.quotas,
        policy: state.policy,
        onEvent: opts.onEvent,
      },
      toolsService,
      clients
    );
    return { mode: "restarted", run };
  }

  private async launch(
    run: ScriptRun,
    request: ExecutionRequest,
    toolsService: ToolsService,
    clients: AIClient
  ): Promise<ScriptRun> {
    this.live.set(run.runId, run);
    if (this.persist) await run.attach(this.store.channel(run.runId));
    // stop the channel's file watchers once the run is over (after its final write)
    void run.completion.then(() => run.close()).catch(() => {});
    this.runWorker(run, request, toolsService, clients).catch((err) => {
      run.terminate("failed", null, err instanceof Error ? err.message : String(err));
    });
    return run;
  }


  // ── queries ─────────────────────────────────────────────────────────────────

  /** A live run of this process, or the persisted record. Throws if unknown. */
  get(runId: string): ScriptRunRecord {
    const own = this.live.get(runId);
    if (own) return own;
    try {
      return this.store.resolve(runId);
    } catch {
      throw new Error(`Script run '${runId}' not found`);
    }
  }

  /** Live runs of this process (no disk). */
  getLive(runId: string): ScriptRun | undefined {
    return this.live.get(runId);
  }

  /** Runs owned here plus runs on disk (other terminals, earlier sessions). */
  list(options?: {
    status?: ScriptRunStatus | ScriptRunStatus[];
    includeTerminal?: boolean;
    ownerTaskId?: string;
    limit?: number;
    /** only runs owned by this process */
    localOnly?: boolean;
  }): ScriptRunRecord[] {
    this.prune();
    const byId = new Map<string, ScriptRunRecord>();
    if (this.persist && !options?.localOnly) {
      for (const r of this.store.list()) byId.set(r.runId, r);
    }
    for (const r of this.live.values()) byId.set(r.runId, r);
    let runs = [...byId.values()];

    if (options?.ownerTaskId) runs = runs.filter((r) => r.ownerTaskId === options.ownerTaskId);
    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      runs = runs.filter((r) => statuses.includes(r.status));
    } else if (options?.includeTerminal === false) {
      runs = runs.filter((r) => !isTerminalScriptStatus(r.status));
    }
    runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (options?.limit && options.limit > 0) runs = runs.slice(0, options.limit);
    return runs;
  }

  /** Wait for a run to reach a terminal state (polls disk for foreign runs). */
  async wait(runId: string, timeoutMs?: number): Promise<ExecutionResult> {
    const own = this.live.get(runId);
    const done: Promise<ExecutionResult> = own
      ? // resolve only once the terminal state is on disk (callers may exit right after)
        own.completion.then(async (r) => { await own.flush(); return r; })
      : this.pollUntil(runId, (r) => isTerminalScriptStatus(r.status) || (r as any).orphaned).then(
          (r) =>
            r.result ?? {
              success: false,
              error: r.error ?? `run is ${(r as any).orphaned ? "orphaned" : r.status}`,
              result: null,
              trace: {} as any,
              artifacts: [],
              consoleOutput: [],
            }
        );
    if (timeoutMs === undefined || timeoutMs <= 0) return done;
    return new Promise<ExecutionResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`waitForScript timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      done.then(
        (r) => { clearTimeout(timer); resolve(r); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  /**
   * Long-poll for events after `afterSequence`. Resolves when there is at
   * least one, the run is terminal, or `timeoutMs` elapses.
   */
  async waitForEvents(
    runId: string,
    afterSequence: number,
    timeoutMs: number
  ): Promise<{ events: ScriptRunEvent[]; terminal: boolean; nextSequence: number }> {
    const collect = (r: ScriptRunRecord) => {
      const events = r.events.filter((e) => e.sequence > afterSequence);
      const nextSequence = events.length ? events[events.length - 1].sequence + 1 : afterSequence;
      return { events, terminal: isTerminalScriptStatus(r.status), nextSequence };
    };
    const ready = (r: ScriptRunRecord) =>
      r.events.some((e) => e.sequence > afterSequence) || isTerminalScriptStatus(r.status);

    const own = this.live.get(runId);
    if (!own) {
      const r = await this.pollUntil(runId, (x) => ready(x) || (x as any).orphaned, timeoutMs);
      return collect(r);
    }
    if (ready(own)) return collect(own);
    await Promise.race([
      own.nextEvent(),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    return collect(own);
  }

  private async pollUntil(
    runId: string,
    predicate: (r: PersistedScriptRun) => boolean,
    timeoutMs?: number
  ): Promise<PersistedScriptRun> {
    const started = Date.now();
    for (;;) {
      const r = this.store.resolve(runId);
      if (predicate(r)) return r;
      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) return r;
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  // ── control ─────────────────────────────────────────────────────────────────

  async cancel(runId: string): Promise<void> {
    const own = this.live.get(runId);
    if (own) {
      if (!own.isTerminal()) own.cancel();
      return;
    }
    const r = this.store.resolve(runId);
    if (isTerminalScriptStatus(r.status)) return;
    if (r.orphaned) {
      // nobody owns it: take it over just long enough to record the outcome
      const run = new ScriptRun({ kind: "script", document: r.document });
      await run.attach(this.store.channel(r.runId));
      run.terminate("cancelled", null, "Cancelled (owner process had exited)");
      await run.close();
      return;
    }
    await this.store.channel(r.runId).writeControl({ desired: "cancelled" });
  }

  async pause(runId: string): Promise<void> {
    const own = this.live.get(runId);
    if (own) return own.pause();
    const r = this.store.resolve(runId);
    if (isTerminalScriptStatus(r.status) || r.orphaned) {
      throw new Error(`Run ${r.runId} is not running (${r.orphaned ? "orphaned" : r.status})`);
    }
    await this.store.channel(r.runId).writeControl({ desired: "paused" });
  }

  /** Send a message into a running script (in-process or via input.txt). */
  sendMessage(
    runId: string,
    type: string,
    data?: unknown,
    options?: { correlationId?: string; source?: ScriptMessage["source"] }
  ): ScriptMessage {
    const own = this.live.get(runId);
    if (own) return own.sendMessage(type, data, options);
    const r = this.store.resolve(runId);
    if (isTerminalScriptStatus(r.status)) {
      throw new Error(`Cannot send message to run ${r.runId} in status '${r.status}'`);
    }
    const item = { kind: type, payload: { type, data: data ?? null }, from: options?.source?.taskId };
    void this.store.channel(r.runId).appendInput(item);
    return {
      id: "",
      sequence: -1, // assigned by the owner when it consumes input.txt
      timestamp: new Date().toISOString(),
      type,
      data: data ?? null,
      correlationId: options?.correlationId,
      source: options?.source,
    };
  }


  // ── worker ──────────────────────────────────────────────────────────────────

  private async runWorker(
    run: ScriptRun,
    request: ExecutionRequest,
    toolsService: ToolsService,
    clients: AIClient
  ): Promise<void> {
    const quotas = { ...this.defaultQuotas, ...request.quotas };
    const policy = { ...this.defaultPolicy, ...request.policy };
    const policyEnforcer = new ScriptPolicyEnforcer(quotas, policy);
    const tracer = new ScriptTracer();
    run.tracer = tracer;

    let availableTools: string[] = [];
    try {
      availableTools = new SandboxContext(toolsService, clients, tracer, policyEnforcer).listToolNames();
    } catch { /* ignore */ }

    // honour a pause/cancel that arrived before the worker started
    await run.gate();

    const child = fork(path.join(__dirname, "script-worker.js"), [], {
      execArgv: ["--no-node-snapshot", "--enable-source-maps"],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    child.stderr?.pipe(process.stderr);
    run.child = child;
    run.markRunning(child.pid);
    run.appendEvent("lifecycle", "started", { quotas, resumeCount: run.resumeCount });

    const bridge = createHostBridge({
      toolsService,
      clients,
      taskId: run.ownerTaskId,
      policyEnforcer,
      gate: () => run.gate(),
      setState: (patch, replace) => run.setScriptState(patch, replace),
      onToolStart: (toolName, params) => {
        if (!AGENT_START_TOOLS.has(toolName)) return;
        run.appendEvent("lifecycle", "agent_start_requested", {
          toolName,
          requestedTaskId: params?.taskId ?? null,
          agentName: params?.agentName ?? params?.agent ?? null,
        });
      },
      onToolResult: (toolName, params, result) => {
        if (AGENT_START_TOOLS.has(toolName)) this.recordAgentStart(run, toolName, params, result);
      },
      onToolError: (toolName, params, err) => {
        if (!AGENT_START_TOOLS.has(toolName)) return;
        run.appendEvent("lifecycle", "agent_start_failed", {
          toolName,
          requestedTaskId: params?.taskId ?? null,
          error: err.message,
        });
      },
    });

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      // Runs are unbounded unless the caller intentionally supplies a deadline.
      const timeoutMs = quotas.maxExecutionTimeMs;
      const globalTimeout = timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            if (!run.isTerminal()) {
              child.kill("SIGKILL");
              run.terminate("timedOut", null, `Execution timed out after ${timeoutMs}ms`);
            }
          }, timeoutMs)
        : undefined;

      const finish = (result: ExecutionResult) => {
        if (globalTimeout) clearTimeout(globalTimeout);
        run.terminate(
          result.success ? "completed" : run.status === "cancelRequested" ? "cancelled" : "failed",
          result,
          result.error ?? undefined
        );
        // Close IPC after the terminal message so the child can exit.
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
            scriptState: run.scriptState,
            runInfo: run.runInfo(),
          });
        } else if (msg.type === "event") {
          const ev = msg.event as { type: string; data?: any };
          const channel: ScriptRunEvent["channel"] = ev.type.startsWith("console_")
            ? "console"
            : ev.type === "script_event" ? "script" : "trace";
          run.appendEvent(channel, ev.type, ev.data ?? {});
          request.onEvent?.(ev as any);
        } else if (msg.type === "script_event") {
          run.appendEvent("script", msg.eventType ?? "emit", msg.data ?? {});
          request.onEvent?.({ type: msg.eventType ?? "emit", data: msg.data ?? {} } as any);
        } else if (msg.type === "wait_for_message") {
          run.waitForMessage(
            { type: msg.messageType, afterSequence: msg.afterSequence, timeoutMs: msg.timeoutMs },
            (message) => {
              if (child.connected) child.send({ type: "wait_for_message_result", id: msg.id, message });
            }
          );
        } else if (await bridge(msg, child)) {
          // tool / llm / decision / agent / setState / checkpoint
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
        run.terminate("failed", null, err.message);
        rejectSpawn(err);
      });

      child.on("exit", (code) => {
        if (globalTimeout) clearTimeout(globalTimeout);
        if (!run.isTerminal() && code !== 0 && code !== null) {
          run.terminate(
            run.status === "cancelRequested" ? "cancelled" : "failed",
            null,
            `Worker exited with code ${code}`
          );
          resolveSpawn();
        }
      });
    });
  }

  /** agent_spawned / agent_sync_* / agent_started events + child monitoring. */
  private recordAgentStart(run: ScriptRun, toolName: string, params: any, result: any): void {
    const taskId = result && typeof result === "object" ? result.taskId ?? result.id ?? null : null;
    if (!taskId) {
      run.appendEvent("lifecycle", "agent_start_failed", {
        toolName,
        error: result?.error ?? "Agent tool returned no taskId",
      });
      return;
    }
    const details = {
      toolName,
      taskId,
      status: result?.status ?? "started",
      pid: result?.pid ?? null,
      syncFs: result?.syncFs ?? null,
      syncReady: result?.syncReady ?? null,
      agentDir: result?.agentDir ?? null,
      logPath: result?.logPath ?? null,
      parentTaskId: result?.parentTaskId ?? run.ownerTaskId ?? null,
      agentName: params?.agentName ?? params?.agent ?? null,
      prompt: typeof params?.prompt === "string" ? params.prompt.slice(0, 200) : null,
    };
    if (result?.success === false) {
      run.appendEvent("lifecycle", "agent_start_failed", { ...details, error: result?.error ?? null });
      return;
    }
    run.appendEvent("lifecycle", "agent_spawned", details);
    if (details.syncFs) {
      run.appendEvent("lifecycle", details.syncReady ? "agent_sync_ready" : "agent_sync_pending", details);
    }
    // Compatibility event for existing script observers.
    run.appendEvent("lifecycle", "agent_started", details);
    if (details.agentDir) this.monitorAgent(run, details);
  }


  /** Relay bounded, change-only child status snapshots into lifecycle events. */
  private monitorAgent(
    run: ScriptRun,
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
          run.appendEvent("lifecycle", "agent_sync_ready", {
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
            run.appendEvent("lifecycle", "agent_progress", {
              taskId: details.taskId,
              message: text.slice(0, 4000),
              truncated: text.length > 4000,
            });
          }
        }
        const signature = JSON.stringify(snapshot);
        if (signature !== lastSnapshot) {
          lastSnapshot = signature;
          const terminal = ["completed", "failed", "cancelled", "error", "killed"].includes(status);
          run.appendEvent(
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
          run.appendEvent("lifecycle", "agent_status_unavailable", {
            taskId: details.taskId,
            agentDir: details.agentDir,
          });
          return;
        }
      }
      if (run.isTerminal()) return;
      setTimeout(poll, 1000).unref?.();
    };
    void poll();
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, run] of this.live) {
      if (run.isTerminal() && run.finishedAt && new Date(run.finishedAt).getTime() < cutoff) {
        this.live.delete(id);
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
