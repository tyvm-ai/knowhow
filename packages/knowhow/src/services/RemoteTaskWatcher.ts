/**
 * RemoteTaskWatcher — mirrors an agent task running on a remote worker into the
 * local chat (CLI equivalent of dashboard/workers/chat?workerId=…).
 *
 *  - polls the cheap task status (`includeThreads=false`) and only fetches the
 *    (large) threads when status/updatedAt/cost changed
 *  - keeps a cursor (ThreadDiffer) so each thread message is rendered once
 *  - backs off while the remote agent is idle
 *  - implements SyncedAgentWatcher, so it plugs into WatcherBackedAgent and
 *    AgentModule.attachedAgentChatLoop (/detach, /kill, /poke, /logs, …)
 */
import { EventService } from "./EventService";
import { KnowhowSimpleClient, TaskDetailsResponse } from "./KnowhowClient";
import type { SyncedAgentWatcher } from "./SyncedAgentWatcher";
import {
  PROJECTION_EVENT_TYPES,
  ThreadDiffer,
} from "./stateful/agent/agentProjection";
import { messagesToRenderEvents } from "../chat/renderer/messagesToRenderEvents";
import {
  startRemoteAgentTask,
  waitForRemoteTaskRunning,
  extractRemoteFinalAnswer,
} from "./RemoteWorkers";

export type ProjectedEvent =
  | { type: "toolCall"; payload: { toolCall: any } }
  | { type: "toolUsed"; payload: { toolCall: any; functionResp: string } }
  | { type: "agentSay"; payload: { message: string } };

export const TERMINAL_STATUSES = new Set(["completed", "killed", "failed", "error", "done"]);

export function isTerminalTask(d?: {
  status?: string;
  inProgress?: boolean;
}): boolean {
  if (!d) return false;
  if (d.status) return TERMINAL_STATUSES.has(d.status);
  return d.inProgress === false;
}

/** Cheap change signature for a task-status response (no threads). */
export function taskSignature(d: Partial<TaskDetailsResponse>): string {
  return [d.status, d.inProgress, d.updatedAt, d.totalUsdCost, d.desiredStatus].join("|");
}

/** Next poll interval: reset on activity, else grow ×1.5 up to max. */
export function nextPollInterval(
  current: number,
  changed: boolean,
  min = 1500,
  max = 6000
): number {
  if (changed) return min;
  return Math.min(max, Math.round(current * 1.5));
}

/**
 * Cursor over a remote task's threads. `seed` establishes the baseline
 * (optionally replaying the last N messages), `next` returns only messages not
 * returned before, converted to the render/agent-event vocabulary.
 */
export class RemoteThreadCursor {
  private differ = new ThreadDiffer([]);

  constructor(
    private taskId: string,
    private agentName = "remote-agent"
  ) {}

  seed(threads: any[][], replayLast = 0) {
    if (replayLast > 0 && threads.length) {
      const last = threads[threads.length - 1] ?? [];
      const cut = Math.max(0, last.length - replayLast);
      const base = [...threads.slice(0, -1), last.slice(0, cut)];
      this.differ.seed(cut === 0 && threads.length === 1 ? [] : base);
    } else {
      this.differ.seed(threads);
    }
  }

  next(threads: any[][], skipUserTexts: Set<string> = new Set()): ProjectedEvent[] {
    const fresh = this.differ.next(threads);
    const out: ProjectedEvent[] = [];
    for (const ev of messagesToRenderEvents(fresh, this.taskId, this.agentName) as any[]) {
      if (ev.type === "toolCall") {
        out.push({ type: "toolCall", payload: { toolCall: ev.toolCall } });
      } else if (ev.type === "toolResult") {
        out.push({
          type: "toolUsed",
          payload: { toolCall: ev.toolCall, functionResp: ev.result },
        });
      } else if (ev.type === "agentMessage") {
        if (ev.role === "user") {
          const t = String(ev.message || "").trim();
          // our own message (the worker may wrap it in plugin context) is already visible
          if ([...skipUserTexts].some((s) => s && t.includes(s))) continue;
          const short = t.length > 300 ? `${t.slice(0, 300)}… [${t.length} chars]` : t;
          out.push({ type: "agentSay", payload: { message: `🧑 ${short}` } });
        } else {
          out.push({ type: "agentSay", payload: { message: ev.message } });
        }
      }
    }
    return out;
  }
}

export interface RemoteTaskWatcherOptions {
  workerId: string;
  workerName: string;
  client?: KnowhowSimpleClient;
  /** replay this many trailing messages of existing history on attach (default 0) */
  replayLast?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
  agentName?: string;
  /** texts the local user already typed (their echo in the remote thread is not re-rendered) */
  sentTexts?: string[];
  /**
   * The task was just resumed: the backend still reports the previous terminal
   * status until the resumed agent syncs. Ignore "completed" until the task
   * shows activity (running status or changed updatedAt/cost) or this long
   * has passed (default 120s).
   */
  awaitRunning?: boolean;
  awaitRunningMs?: number;
  /** warn when a newly started remote agent produced nothing for this long (default 60s) */
  startupWarnMs?: number;
  /** log path on the worker (from startAgentTask) to point the user at */
  logPath?: string;
}

export class RemoteTaskWatcher implements SyncedAgentWatcher {
  public taskId = "";
  public agentName = "remote-agent";
  public agentEvents = new EventService();
  public eventTypes = { ...PROJECTION_EVENT_TYPES };
  /** marker used by the chat module to special-case /detach and /status */
  public readonly isRemoteWorkerWatcher = true;
  public readonly workerId: string;
  public readonly workerName: string;

  private client: KnowhowSimpleClient;
  private cursor?: RemoteThreadCursor;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private interval: number;
  private lastSig?: string;
  private polling = false;
  private sawActivity = false;
  private pendingReplay: ProjectedEvent[] = [];
  private sawMessages = false;
  private warnedStall = false;
  private sent = new Set<string>();
  public lastStatus?: Partial<TaskDetailsResponse>;
  public startedAt = Date.now();
  /** number of full-thread fetches (for tests / diagnostics) */
  public threadFetches = 0;

  constructor(private opts: RemoteTaskWatcherOptions) {
    this.client = opts.client ?? new KnowhowSimpleClient();
    this.workerId = opts.workerId;
    this.workerName = opts.workerName;
    this.agentName = opts.agentName ?? `${opts.workerName}`;
    this.interval = opts.pollMinMs ?? 1500;
    for (const t of opts.sentTexts ?? []) this.sent.add(t.trim());
  }

  private get min() {
    return this.opts.pollMinMs ?? 1500;
  }
  private get max() {
    return this.opts.pollMaxMs ?? 6000;
  }

  async startWatching(taskId: string): Promise<void> {
    this.taskId = taskId;
    this.stopped = false;
    this.startedAt = Date.now();
    this.sawActivity = !this.opts.awaitRunning;
    this.cursor = new RemoteThreadCursor(taskId, this.agentName);
    // Baseline: don't re-print history (optionally replay the tail for context)
    let threads: any[][] = [];
    try {
      const full = (await this.client.getTaskDetails(taskId, true)).data;
      threads = full.threads ?? [];
      this.lastStatus = full;
      this.lastSig = taskSignature(full);
      this.threadFetches++;
    } catch {
      /* new task may not exist yet; start from empty */
    }
    const replay = this.opts.replayLast ?? 0;
    this.cursor.seed(threads, replay);
    // Replay is emitted by flushReplay() once the chat has wired its renderer
    // (listeners are attached after startWatching returns).
    if (replay > 0) this.pendingReplay = this.cursor.next(threads);
    console.log(
      `🛰️ Mirroring remote task ${taskId} on ${this.workerName}. /detach to leave it running, /kill to stop it.`
    );
    this.schedule(this.min);
  }

  /**
   * A remote agent that crashed on startup (e.g. no model credentials on a
   * fresh sandbox) never marks the task failed — it just stays "pending" with
   * no messages. Tell the user instead of mirroring silence forever.
   */
  private warnIfStalled() {
    if (this.warnedStall || this.sawMessages || this.stopped) return;
    const limit = this.opts.startupWarnMs ?? 60_000;
    if (Date.now() - this.startedAt < limit) return;
    if (this.lastStatus?.inProgress === true && this.lastStatus?.status === "running") return;
    this.warnedStall = true;
    console.warn(
      `⚠️ Remote task ${this.taskId} has produced no output for ${Math.round(limit / 1000)}s — the agent may have failed to start on ${this.workerName}.` +
        (this.opts.logPath
          ? `\n   Check: knowhow workers exec ${this.workerName} -- tail -30 ${this.opts.logPath}`
          : "")
    );
  }

  /** Emit the buffered tail of existing history (call after listeners are wired). */
  flushReplay(): void {
    const events = this.pendingReplay;
    this.pendingReplay = [];
    if (events.length) {
      console.log("── recent history ──");
      this.emitEvents(events);
      console.log("── live ──");
    }
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), ms);
    (this.timer as any).unref?.();
  }

  stopWatching(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emitEvents(events: ProjectedEvent[]) {
    for (const ev of events) {
      const type = this.eventTypes[ev.type];
      this.agentEvents.emit(type, ev.payload);
    }
  }

  /** One poll step; exposed for tests. Returns true if the task is terminal. */
  async poll(): Promise<boolean> {
    if (this.stopped || this.polling) return false;
    this.polling = true;
    let changed = false;
    let terminal = false;
    try {
      const d = (await this.client.getTaskDetails(this.taskId, false)).data;
      this.lastStatus = { ...this.lastStatus, ...d, threads: undefined };
      const sig = taskSignature(d);
      changed = sig !== this.lastSig;
      if (!isTerminalTask(d) || changed) this.sawActivity = true;
      terminal = isTerminalTask(d);
      if (
        terminal &&
        !this.sawActivity &&
        Date.now() - this.startedAt < (this.opts.awaitRunningMs ?? 120_000)
      ) {
        terminal = false; // stale pre-resume state
      }
      if (changed || terminal) {
        const full = (await this.client.getTaskDetails(this.taskId, true)).data;
        this.threadFetches++;
        this.lastSig = taskSignature(full);
        const threads = full.threads ?? [];
        if (threads.some((t: any[]) => t && t.length)) this.sawMessages = true;
        const events = this.cursor!.next(threads, this.sent);
        if (events.length) {
          this.emitEvents(events);
          this.agentEvents.emit(
            this.eventTypes.threadUpdate,
            threads[threads.length - 1] ?? []
          );
        }
        if (terminal) {
          this.stopped = true;
          const result = full.result ??
            d.result ??
            extractRemoteFinalAnswer(threads) ??
            lastText(threads) ??
            "Remote agent finished";
          this.agentEvents.emit(this.eventTypes.done, result);
          return true;
        }
      }
    } catch (e: any) {
      if (e?.status === 404 || e?.response?.status === 404) {
        // task not synced yet; keep trying
      }
    } finally {
      this.polling = false;
    }
    this.warnIfStalled();
    this.interval = nextPollInterval(this.interval, changed, this.min, this.max);
    this.schedule(this.interval);
    return terminal;
  }

  async sendMessage(message: string): Promise<void> {
    this.sent.add(message.trim());
    const d = (await this.client.getTaskDetails(this.taskId, false)).data;
    if (isTerminalTask(d)) {
      // Finished task: continue the conversation by resuming it on the worker.
      await startRemoteAgentTask(
        { worker: this.workerId, prompt: message, resumeTaskId: this.taskId },
        this.client
      );
      await waitForRemoteTaskRunning(this.taskId, { client: this.client });
      if (this.stopped) {
        this.stopped = false;
        this.lastSig = undefined;
        this.interval = this.min;
        this.schedule(this.min);
      }
    } else {
      await this.sendWithRetry(message, d?.status);
    }
    this.interval = this.min;
    this.schedule(this.min);
  }

  /**
   * The backend only accepts messages for tasks whose status is running/paused;
   * a just-started remote task reports "pending" for a while. Retry for a bit,
   * then fail with a short, readable error (instead of a raw HTTP dump).
   */
  private async sendWithRetry(message: string, status?: string, waitMs = 30_000) {
    const deadline = Date.now() + waitMs;
    let notified = false;
    while (true) {
      try {
        await this.client.sendMessageToAgent(this.taskId, message);
        return;
      } catch (e: any) {
        const http = e?.status ?? e?.response?.status;
        const pending = !status || /^(pending|queued|starting)$/i.test(status);
        if (pending && Date.now() < deadline) {
          if (!notified) {
            console.log(`⏳ remote task is ${status ?? "starting"}; message will be sent once it is running…`);
            notified = true;
          }
          await new Promise((r) => setTimeout(r, 2500));
          try {
            status = (await this.client.getTaskDetails(this.taskId, false)).data.status;
          } catch {
            /* keep trying */
          }
          continue;
        }
        throw new Error(
          `could not send message to remote task ${this.taskId} (status: ${status ?? "unknown"}${
            http ? `, HTTP ${http}` : ""
          }); try again in a moment`
        );
      }
    }
  }

  async getThreads(): Promise<any[][]> {
    const d = (await this.client.getTaskDetails(this.taskId, true)).data;
    return d.threads ?? [];
  }

  async pause(): Promise<void> {
    await this.client.pauseAgent(this.taskId);
  }
  async unpause(): Promise<void> {
    await this.client.resumeAgent(this.taskId);
  }
  async kill(): Promise<void> {
    try {
      await this.client.killAgent(this.taskId);
    } catch (e: any) {
      // The backend answers 500 ("Task is not running") for finished/never-started tasks.
      let status: Partial<TaskDetailsResponse> | undefined;
      try {
        status = (await this.client.getTaskDetails(this.taskId, false)).data;
      } catch {
        /* ignore */
      }
      if (status && (isTerminalTask(status) || status.inProgress === false)) {
        console.log(`ℹ️ Remote task ${this.taskId} is not running (status: ${status.status}); nothing to kill.`);
        return;
      }
      throw new Error(`could not kill remote task ${this.taskId}: ${e?.message ?? e}`);
    }
  }
  async interrupt(message?: string): Promise<void> {
    await this.client.sendMessageToAgent(
      this.taskId,
      `/poke ${message || ""}`.trim()
    );
  }

  /** Text printed when the user detaches (remote keeps running). */
  detachMessage(): string {
    return [
      `🔌 Detached. Remote task ${this.taskId} keeps running on ${this.workerName}.`,
      `   Re-attach: knowhow workers attach ${this.workerName} --task ${this.taskId}`,
      `   (or in chat: /workers ${this.workerName} --task ${this.taskId})`,
    ].join("\n");
  }

  statusLine(): string {
    const s = this.lastStatus;
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    return `🛰️ ${this.workerName} · task ${this.taskId} · ${s?.status ?? "unknown"}${
      typeof s?.totalUsdCost === "number" ? ` · $${s.totalUsdCost.toFixed(4)}` : ""
    } · attached ${secs}s`;
  }
}

function lastText(threads: any[][]): string | undefined {
  const last = threads[threads.length - 1] ?? [];
  for (let i = last.length - 1; i >= 0; i--) {
    const m = last[i];
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content;
    }
  }
  return undefined;
}
