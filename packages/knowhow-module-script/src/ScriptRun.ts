/**
 * ScriptRun — one async script run as a StatefulProcess.
 *
 * STATE (written only by the run): status, events (bounded ring), result,
 * the script's own resumable `scriptState`, resume count, message counters.
 * CONTROL (written from outside): pause / resume / cancel (control.json, or
 * `run.pause()` etc. in-process).
 * INPUTS: messages for `waitForMessage`/`onMessage` (input.txt lines, or
 * `sendMessage` in-process).
 *
 * Persisted by an FsProcessChannel to `.knowhow/processes/scripts/<runId>/`
 * (state.json, control.json, input.txt) next to the script source
 * (`script.js`), so any terminal can list, watch, pause, message, cancel
 * or resume it.
 *
 * Resuming is NOT replay: it starts the same script fresh with the last
 * persisted `scriptState` (and `runInfo.resumed === true`). A script is
 * resumable when it records its progress with `setState()` and reads it
 * back by destructuring the `scriptState` global.
 */

import type { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as os from "os";
import {
  BaseControl,
  InputCursor,
  InputItem,
  ProcessCancelledError,
  ProcessDocument,
  ProcessInit,
  StatefulProcess,
  isTerminalStatus,
} from "@tyvm/knowhow/sdk";
import type { ScriptTracer } from "./ScriptTracer";
import type { ExecutionResult, ResourceQuotas, SecurityPolicy } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScriptRunStatus =
  | "starting"
  | "running"
  | "paused"
  | "cancelRequested"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut";

export const TERMINAL_SCRIPT_STATUSES: readonly ScriptRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timedOut",
];

export function isTerminalScriptStatus(status: string): boolean {
  return (TERMINAL_SCRIPT_STATUSES as readonly string[]).includes(status);
}

export interface ScriptRunEvent {
  runId: string;
  sequence: number;
  id: string;
  timestamp: string;
  type: string;
  channel: "script" | "console" | "trace" | "lifecycle";
  data: unknown;
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

/**
 * The read-only view of a run. Implemented by live `ScriptRun`s and by
 * persisted runs read from disk (other terminals / finished runs).
 */
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
  events: ScriptRunEvent[];
  nextEventSequence: number;
  droppedEventCount: number;
  scriptState?: Record<string, unknown>;
  resumeCount?: number;
}

export interface ScriptRunState {
  runId: string;
  name?: string;
  status: ScriptRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  ownerTaskId?: string;
  childPid?: number;
  /** result with the trace reduced to its metrics */
  result?: ExecutionResult;
  error?: string;
  events: ScriptRunEvent[];
  nextEventSequence: number;
  droppedEventCount: number;
  /** where the source came from; the text itself is in `<dir>/script.js` */
  source: { path?: string; length: number };
  args: Record<string, unknown>;
  quotas?: ResourceQuotas;
  policy?: Partial<SecurityPolicy>;
  /** the script's own resumable state (setState / scriptState) */
  scriptState: Record<string, unknown>;
  resumeCount: number;
  nextInputSequence: number;
  inputCursors?: Record<string, unknown>;
}

export type ScriptControl = BaseControl;

export const SCRIPT_PROCESS_KIND = "script";
export const MAX_EVENTS_PER_RUN = 1000;

type MessageWaiter = {
  type?: string;
  afterSequence?: number;
  resolve: (msg: ScriptMessage | null) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

/** Reduce a result to what is worth persisting (the full trace is not). */
export function persistableResult(result: ExecutionResult): ExecutionResult {
  const metrics = (result.trace as any)?.metrics;
  return {
    ...result,
    trace: (metrics ? { metrics } : {}) as any,
    consoleOutput: [],
  };
}

// ── Process ───────────────────────────────────────────────────────────────────

export class ScriptRun
  extends StatefulProcess<ScriptRunState, ScriptControl, ScriptRunEvent>
  implements ScriptRunRecord
{
  /** resolves when the run reaches a terminal state */
  readonly completion: Promise<ExecutionResult>;
  private resolveCompletion!: (r: ExecutionResult) => void;
  private messageQueue: ScriptMessage[] = [];
  private messageWaiters: MessageWaiter[] = [];
  private eventWaiters: Array<() => void> = [];
  private cancelGrace?: ReturnType<typeof setTimeout>;

  child?: ChildProcess;
  tracer?: ScriptTracer;

  constructor(init: ProcessInit<ScriptRunState, ScriptControl>) {
    super({
      ...init,
      kind: SCRIPT_PROCESS_KIND,
      lifecycle: { resumable: "checkpoint", ...init.lifecycle },
    });
    this.completion = new Promise<ExecutionResult>((resolve) => {
      this.resolveCompletion = resolve;
    });
    // never an unhandled rejection: completion only ever resolves
  }

  static create(opts: {
    runId?: string;
    name?: string;
    ownerTaskId?: string;
    source: ScriptRunState["source"];
    args?: Record<string, unknown>;
    quotas?: ResourceQuotas;
    policy?: Partial<SecurityPolicy>;
    scriptState?: Record<string, unknown>;
  }): ScriptRun {
    const runId = opts.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    return new ScriptRun({
      id: runId,
      kind: SCRIPT_PROCESS_KIND,
      name: opts.name,
      parentId: opts.ownerTaskId,
      state: {
        runId,
        name: opts.name,
        status: "starting",
        createdAt: now,
        ownerTaskId: opts.ownerTaskId,
        events: [],
        nextEventSequence: 0,
        droppedEventCount: 0,
        source: opts.source,
        args: opts.args ?? {},
        quotas: opts.quotas,
        policy: opts.policy,
        scriptState: opts.scriptState ?? {},
        resumeCount: 0,
        nextInputSequence: 0,
      },
    });
  }

  /**
   * Continue a persisted run in this process: same runId, same script,
   * starting fresh with the persisted scriptState. Clears the previous
   * terminal outcome; the event history is kept.
   */
  static fromDocument(doc: ProcessDocument<ScriptRunState, ScriptControl>): ScriptRun {
    const run = new ScriptRun({ kind: SCRIPT_PROCESS_KIND, document: doc });
    run.prepareResume();
    return run;
  }

  private prepareResume(): void {
    // A desired "cancelled"/"paused" left in control from the previous owner
    // must not immediately stop the new run.
    if (this.getControl().desired && this.getControl().desired !== "running") {
      this.applyControl({ desired: "running" }, "resume");
    }
    const prior = this.getState().status;
    this.update(
      (s) => {
        s.resumeCount += 1;
        s.status = "starting";
        s.finishedAt = undefined;
        s.error = undefined;
        s.result = undefined;
        s.childPid = undefined;
      },
      { reason: "resume" }
    );
    this.appendEvent("lifecycle", "run_resumed", {
      resumeCount: this.getState().resumeCount,
      previousStatus: prior,
      scriptState: this.getState().scriptState,
    });
  }

  // ── ScriptRunRecord view ────────────────────────────────────────────────────
  get runId() { return this.getState().runId; }
  get name() { return this.getState().name; }
  get status(): ScriptRunStatus {
    const s = this.getState().status;
    return this.getLifecycle().status === "paused" && !isTerminalScriptStatus(s) ? "paused" : s;
  }
  get createdAt() { return this.getState().createdAt; }
  get startedAt() { return this.getState().startedAt; }
  get finishedAt() { return this.getState().finishedAt; }
  get ownerTaskId() { return this.getState().ownerTaskId; }
  get childPid() { return this.getState().childPid; }
  get result() { return this.getState().result; }
  get error() { return this.getState().error; }
  get events() { return this.getState().events; }
  get nextEventSequence() { return this.getState().nextEventSequence; }
  get droppedEventCount() { return this.getState().droppedEventCount; }
  get scriptState() { return this.getState().scriptState; }
  get resumeCount() { return this.getState().resumeCount; }

  isTerminal(): boolean {
    return isTerminalScriptStatus(this.getState().status);
  }

  /** the worker's `runInfo` global */
  runInfo() {
    const s = this.getState();
    return { runId: s.runId, name: s.name ?? null, resumed: s.resumeCount > 0, resumeCount: s.resumeCount };
  }

  // ── owner writes ────────────────────────────────────────────────────────────

  appendEvent(channel: ScriptRunEvent["channel"], type: string, data: unknown): ScriptRunEvent {
    let event!: ScriptRunEvent;
    this.update(
      (s) => {
        if (s.events.length >= MAX_EVENTS_PER_RUN) {
          s.events.shift();
          s.droppedEventCount++;
        }
        event = {
          runId: s.runId,
          sequence: s.nextEventSequence++,
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type,
          channel,
          data,
        };
        s.events.push(event);
      },
      { reason: `event:${type}` }
    );
    this.emit(event);
    this.wakeEventWaiters();
    return event;
  }

  markRunning(childPid?: number): void {
    this.update((s) => {
      s.status = "running";
      s.startedAt = s.startedAt ?? new Date().toISOString();
      s.childPid = childPid;
    });
    if (this.getLifecycle().status !== "running") {
      // (also clears the outcome of a previous attempt when resuming)
      this.setStatus("running", {
        endedAt: undefined,
        result: undefined,
        error: undefined,
        executor: { host: os.hostname(), pid: process.pid, heartbeatAt: new Date().toISOString() },
      });
    }
  }

  setChildPid(pid?: number): void {
    this.update((s) => {
      s.childPid = pid;
    });
  }

  /** setState() from the script: commit, then wait until it is on disk. */
  async setScriptState(
    patch: Record<string, unknown>,
    replace: boolean
  ): Promise<Record<string, unknown>> {
    this.update(
      (s) => {
        s.scriptState = replace ? patch : { ...s.scriptState, ...patch };
      },
      { reason: "script_state" }
    );
    const version = this.snapshot().version;
    await this.persisted(version).catch(() => {});
    return this.getState().scriptState;
  }

  /** The pause gate used before every bridged call and by `checkpoint()`. */
  async gate(): Promise<void> {
    if (this.isTerminal()) return;
    await this.checkpoint();
  }

  terminate(status: ScriptRunStatus, result: ExecutionResult | null, error?: string): void {
    if (this.isTerminal()) return;
    if (this.cancelGrace) clearTimeout(this.cancelGrace);
    const final: ExecutionResult =
      result ?? {
        success: false,
        error: error ?? "Unknown error",
        result: null,
        trace: (this.tracer?.getTrace() ?? {}) as any,
        artifacts: [],
        consoleOutput: [],
      };
    this.update(
      (s) => {
        s.status = status;
        s.finishedAt = new Date().toISOString();
        s.error = error;
        s.result = persistableResult(final);
      },
      { reason: `terminal:${status}` }
    );
    this.appendEvent("lifecycle", `run_${status}`, { error });

    if (status === "completed") this.setStatus("completed", { result: final.result });
    else if (status === "cancelled") this.setStatus("cancelled");
    else this.setStatus("failed", { error: { message: error ?? status, code: status } });

    for (const waiter of this.messageWaiters.splice(0)) {
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      waiter.resolve(null);
    }
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
    this.wakeEventWaiters();
    this.resolveCompletion(final);
  }

  // ── control hooks ─────────────────────────────────────────────────────────

  protected onPause(): void {
    this.appendEvent("lifecycle", "pause_requested", {});
  }

  protected onResume(): void {
    this.appendEvent("lifecycle", "resumed", {});
  }

  protected onCancel(): void {
    if (this.isTerminal()) return;
    this.update((s) => {
      s.status = "cancelRequested";
    });
    this.appendEvent("lifecycle", "cancel_requested", {});
    if (!this.child) {
      this.terminate("cancelled", null, "Cancelled by request");
      return;
    }
    // Cooperative first (isCancelled / untilCancelled), SIGKILL after 3s.
    if (this.child.connected) this.child.send({ type: "cancel" });
    this.cancelGrace = setTimeout(() => {
      if (!this.isTerminal()) {
        this.child?.kill("SIGKILL");
        this.terminate("cancelled", null, "Cancelled by request");
      }
    }, 3000);
    (this.cancelGrace as any).unref?.();
  }

  // ── inputs: messages for waitForMessage / onMessage ───────────────────────

  /** in-process send (sendScriptMessage tool) */
  sendMessage(
    type: string,
    data?: unknown,
    options?: { correlationId?: string; source?: ScriptMessage["source"] }
  ): ScriptMessage {
    if (this.isTerminal()) {
      throw new Error(`Cannot send message to run ${this.runId} in status '${this.status}'`);
    }
    let msg!: ScriptMessage;
    this.update(
      (s) => {
        msg = {
          id: randomUUID(),
          sequence: s.nextInputSequence++,
          timestamp: new Date().toISOString(),
          type,
          data: data ?? null,
          correlationId: options?.correlationId,
          source: options?.source,
        };
      },
      { reason: "message" }
    );
    this.deliverMessage(msg);
    return msg;
  }

  /** input.txt lines (another terminal / `knowhow scripts send`) */
  protected onInput(items: InputItem[], cursor: InputCursor): void {
    const messages: ScriptMessage[] = [];
    this.consume(items, cursor, (s) => {
      for (const item of items) {
        const payload: any = item.payload;
        const type =
          item.kind && item.kind !== "message" && item.kind !== "text"
            ? item.kind
            : typeof payload?.type === "string"
              ? payload.type
              : "message";
        const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
        messages.push({
          id: item.id,
          sequence: s.nextInputSequence++,
          timestamp: item.at,
          type,
          data: data ?? null,
          source: item.from ? { taskId: item.from } : undefined,
        });
      }
    });
    if (this.isTerminal()) return;
    for (const msg of messages) this.deliverMessage(msg);
  }

  private deliverMessage(msg: ScriptMessage): void {
    const idx = this.messageWaiters.findIndex(
      (w) => (!w.type || w.type === msg.type) &&
             (w.afterSequence === undefined || msg.sequence > w.afterSequence)
    );
    if (idx !== -1) {
      const [waiter] = this.messageWaiters.splice(idx, 1);
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      waiter.resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  /** worker asked for the next message (waitForMessage) */
  waitForMessage(
    opts: { type?: string; afterSequence?: number; timeoutMs?: number },
    reply: (msg: ScriptMessage | null) => void
  ): void {
    const idx = this.messageQueue.findIndex(
      (m) => (!opts.type || m.type === opts.type) &&
             (opts.afterSequence === undefined || m.sequence > opts.afterSequence)
    );
    if (idx !== -1) {
      reply(this.messageQueue.splice(idx, 1)[0]);
      return;
    }
    if (this.isTerminal()) {
      reply(null);
      return;
    }
    const waiter: MessageWaiter = { type: opts.type, afterSequence: opts.afterSequence, resolve: reply };
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      waiter.timeoutHandle = setTimeout(() => {
        const i = this.messageWaiters.indexOf(waiter);
        if (i !== -1) this.messageWaiters.splice(i, 1);
        reply(null);
      }, opts.timeoutMs);
    }
    this.messageWaiters.push(waiter);
  }

  // ── observers ───────────────────────────────────────────────────────────────

  /** resolves on the next event or terminal state */
  nextEvent(): Promise<void> {
    if (this.isTerminal()) return Promise.resolve();
    return new Promise((resolve) => this.eventWaiters.push(resolve));
  }

  private wakeEventWaiters(): void {
    for (const w of this.eventWaiters.splice(0)) {
      try { w(); } catch { /* ignore */ }
    }
  }
}

export { ProcessCancelledError, isTerminalStatus };
