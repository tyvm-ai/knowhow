import * as fs from "fs";
import * as path from "path";
import { DuplexChannel } from "../channels/base";
import type { DocSource, OutputPolicy } from "../channels/Channel";
import { FileInputChannel, appendInput } from "../channels/inputStream";
import type { FileCursor, FileInputChannelOptions } from "../channels/inputStream";
import { writeControlFile, writeJsonAtomic } from "../channels/JsonFileChannel";
import type { ProcessDocument, ProcessStatus, Unsubscribe } from "../types";
import { isTerminalStatus } from "../types";
import type { AgentControl, AgentEvent, AgentState } from "./types";

export const AGENTS_DIR = ".knowhow/processes/agents";

/** Legacy `status.txt` vocabulary (what other tools and humans read/write). */
export function legacyStatusFile(status: ProcessStatus): string {
  switch (status) {
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "killed";
    default:
      return "running";
  }
}

/** Legacy `metadata.json` status (never "paused": that only ever lived in status.txt). */
function legacyMetadataStatus(status: ProcessStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "killed";
    default:
      return "running";
  }
}

/** status.txt written from outside -> typed control. `undefined`: not a control value. */
export function controlFromStatusFile(text: string): Partial<AgentControl> | undefined {
  switch (text) {
    case "paused":
      return { desired: "paused" };
    case "running":
      return { desired: "running" };
    case "killed":
      return { desired: "cancelled" };
    default:
      return undefined;
  }
}

async function readJsonFile<T = any>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Persist the remote identity next to a local task (also usable without a
 * running session, e.g. /sync:remote on a finished task).
 */
export async function persistRemoteIdentity(
  taskId: string,
  remoteTaskId: string,
  remoteMessageId?: string,
  baseDir = AGENTS_DIR
): Promise<void> {
  const file = path.join(baseDir, taskId, "metadata.json");
  const metadata = (await readJsonFile<any>(file)) ?? {};
  metadata.remoteTaskId = remoteTaskId;
  metadata.knowhowTaskId = remoteTaskId;
  if (remoteMessageId) {
    metadata.remoteMessageId = remoteMessageId;
    metadata.knowhowMessageId = remoteMessageId;
  }
  await writeJsonAtomic(file, metadata);
}

export interface AgentFsChannelOptions {
  taskId: string;
  baseDir?: string;
  policy?: OutputPolicy;
  pollMs?: number;
  input?: Partial<FileInputChannelOptions>;
}

/**
 * Duplex channel over the legacy per-task directory
 * `.knowhow/processes/agents/<taskId>/`:
 *   metadata.json  (out)  same fields as the old AgentSyncFs wrote
 *   status.txt     (out: owner status; in: paused | running | killed)
 *   input.txt      (in)   input-stream protocol (cursor stored with the message)
 *   usage.json     (out)  per-call token usage + message chain
 * It is also a `DocSource` so `ProcessMirror` can attach to a running task.
 */
export class AgentFsChannel
  extends DuplexChannel<AgentState, AgentControl, AgentEvent>
  implements DocSource<AgentState, AgentControl, AgentEvent>
{
  readonly id = "fs";
  readonly dir: string;
  private input: FileInputChannel<AgentState, AgentControl, AgentEvent>;
  private pollMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private watcher?: fs.FSWatcher;
  /** what status.txt held (and its mtime) when we last wrote or read it */
  private lastSeen?: string;
  private lastSeenMtime?: number;
  private checking: Promise<void> = Promise.resolve();

  constructor(opts: AgentFsChannelOptions) {
    super();
    this.dir = path.join(opts.baseDir ?? AGENTS_DIR, opts.taskId);
    this.policy = opts.policy;
    this.pollMs = opts.pollMs ?? 250;
    this.input = new FileInputChannel({
      pollMs: this.pollMs,
      ...opts.input,
      id: this.id,
      path: path.join(this.dir, "input.txt"),
    });
  }

  private get statusPath() {
    return path.join(this.dir, "status.txt");
  }
  private get metadataPath() {
    return path.join(this.dir, "metadata.json");
  }
  private get inputPath() {
    return path.join(this.dir, "input.txt");
  }

  protected async onStart(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    // a stale "killed"/"paused" from a previous run must not control this one
    await this.writeStatus("running");
    // touch (never truncate): a resumed task may have unread input
    await (await fs.promises.open(this.inputPath, "a")).close();
    await this.writeMetadata(this.ctx.snapshot());
    await this.input.start(this.ctx);
    try {
      this.watcher = fs.watch(this.dir, (_e, name) => {
        if (!name || name === "status.txt") void this.checkStatus();
      });
      this.watcher.on("error", () => {});
    } catch {
      // hint only; polling still works
    }
    // NOT unref'd on purpose: a live agent session may sit idle (paused, or in
    // a long tool call) with nothing else to keep the process alive, and it
    // must stay reachable through status.txt / input.txt. close() / stop()
    // clear it.
    this.timer = setInterval(() => void this.checkStatus(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = this.watcher = undefined;
    await this.checking;
    await this.input.stop();
  }

  async flush(): Promise<void> {
    await this.checkStatus();
    await this.input.flush();
  }

  // ---- control in (status.txt) ----------------------------------------------

  private async writeNow(text: string): Promise<void> {
    await fs.promises.writeFile(this.statusPath, text, "utf8");
    this.lastSeen = text;
    this.lastSeenMtime = (await fs.promises.stat(this.statusPath)).mtimeMs;
  }

  /**
   * Read status.txt; an outsider's write (new content OR a new mtime, so
   * writing the same word again counts) becomes control. True when applied.
   * Our own writes update lastSeen/lastSeenMtime inside the same chain, so they
   * are never mistaken for outside writes.
   */
  private async readAndApply(): Promise<boolean> {
    let text: string;
    let mtime: number;
    try {
      mtime = (await fs.promises.stat(this.statusPath)).mtimeMs;
      text = (await fs.promises.readFile(this.statusPath, "utf8")).trim();
    } catch {
      return false;
    }
    if (text === this.lastSeen && mtime === this.lastSeenMtime) return false;
    this.lastSeen = text;
    this.lastSeenMtime = mtime;
    const patch = controlFromStatusFile(text);
    if (!patch) {
      // an owner value (completed / failed) or something unknown: the channel decides
      if (!["completed", "failed", "created"].includes(text)) {
        this.ctx.log.warn(`fs channel: ignoring unknown status.txt value "${text}"`);
      }
      return false;
    }
    this.ctx.applyControl(patch);
    return true;
  }

  private chain<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.checking.then(fn, fn);
    this.checking = p.then(() => {}, () => {});
    return p;
  }

  checkStatus(): Promise<boolean> {
    return this.chain(() => this.readAndApply());
  }

  private writeStatus(text: string): Promise<void> {
    return this.chain(() => this.writeNow(text));
  }

  /**
   * Publish the owner status unless an outsider wrote status.txt in the
   * meantime: that write is applied as control instead of being clobbered, and
   * the resulting newer document writes the up-to-date status.
   */
  private syncOwnerStatus(text: string): Promise<void> {
    return this.chain(async () => {
      if (await this.readAndApply()) return;
      if (this.lastSeen === text) return;
      // an outsider may have written between the read above and now (the
      // window is tiny, but the file is shared in both directions): look again
      // right before writing
      try {
        const mtime = (await fs.promises.stat(this.statusPath)).mtimeMs;
        if (mtime !== this.lastSeenMtime && (await this.readAndApply())) return;
      } catch {
        // file gone: just write it
      }
      await this.writeNow(text);
    });
  }

  // ---- state out ------------------------------------------------------------------

  async publish(
    doc: ProcessDocument<AgentState, AgentControl>,
    events: AgentEvent[]
  ): Promise<void> {
    await this.writeMetadata(doc);
    await this.syncOwnerStatus(legacyStatusFile(doc.lifecycle.status));
    for (const e of events) {
      if (e.type === "usage") await this.appendUsageEntry(e.usage);
    }
  }

  private async writeMetadata(doc: ProcessDocument<AgentState, AgentControl>) {
    const { state, lifecycle, meta } = doc;
    // merge so identity written earlier (remote ids, ...) is never discarded
    const existing = (await readJsonFile<Record<string, unknown>>(this.metadataPath)) ?? {};
    const terminal = isTerminalStatus(lifecycle.status);
    const out: Record<string, unknown> = {
      ...existing,
      taskId: meta.id,
      pid: process.pid,
      prompt: state.prompt,
      agentName: state.agentName,
      ...(meta.parentId ? { parentTaskId: meta.parentId } : {}),
      startTime: meta.createdAt,
      status: legacyMetadataStatus(lifecycle.status),
      threads: state.threads,
      totalCostUsd: state.totalCostUsd,
      tokenUsage: state.tokenUsage,
      model: state.model,
      provider: state.provider,
      reasoningEffort: state.reasoningEffort,
      summarizeReasoning: state.summarizeReasoning,
      enabledTools: state.enabledTools,
      inProgress: !terminal,
      lastUpdate: new Date().toISOString(),
      pendingUserMessages: state.pendingUserMessages,
    };
    const cursor = state.inputCursors?.[this.id] as FileCursor | undefined;
    if (cursor) out.inputCursor = cursor;
    if (meta.links?.remoteTaskId) {
      out.remoteTaskId = meta.links.remoteTaskId;
      out.knowhowTaskId = meta.links.remoteTaskId;
    }
    if (meta.links?.remoteMessageId) {
      out.remoteMessageId = meta.links.remoteMessageId;
      out.knowhowMessageId = meta.links.remoteMessageId;
    }
    if (lifecycle.result !== undefined && terminal) out.result = lifecycle.result;
    else delete out.result;
    if (lifecycle.error) out.error = lifecycle.error;
    await writeJsonAtomic(this.metadataPath, out);
  }

  /**
   * Append a token usage entry (with the message chain sent for that call) to
   * usage.json, for debugging cache hits. If the new thread has the previous
   * entry's thread as a prefix, the previous thread collapses to
   * { PREV_CACHE_HIT: true } so the file does not grow quadratically.
   */
  private async appendUsageEntry(entry: any): Promise<void> {
    const usagePath = path.join(this.dir, "usage.json");
    const entries: any[] = (await readJsonFile<any[]>(usagePath)) ?? [];
    const last = entries[entries.length - 1];
    const prev: any[] = last?.messages;
    const next: any[] = entry?.messages;
    if (
      Array.isArray(prev) &&
      Array.isArray(next) &&
      prev.length > 0 &&
      next.length >= prev.length &&
      JSON.stringify(next.slice(0, prev.length)) === JSON.stringify(prev)
    ) {
      last.messages = [{ PREV_CACHE_HIT: true }];
    }
    entries.push(entry);
    await fs.promises.writeFile(usagePath, JSON.stringify(entries, null, 2), "utf8");
  }

  // ---- DocSource (mirror side: attach to a running task from another process) --

  private mirrorVersion = 0;

  private async readLegacy(): Promise<ProcessDocument<AgentState, AgentControl> | undefined> {
    const meta = await readJsonFile<any>(this.metadataPath);
    if (!meta) return undefined;
    let status: string | undefined;
    try {
      status = (await fs.promises.readFile(this.statusPath, "utf8")).trim();
    } catch {
      // no status.txt
    }
    return docFromLegacy(path.basename(this.dir), meta, status, this.mirrorVersion);
  }

  async readDocument() {
    const doc = await this.readLegacy();
    if (doc) this.mirrorVersion = Math.max(this.mirrorVersion, 1);
    return doc && { ...doc, version: this.mirrorVersion };
  }

  watchDocument(
    cb: (doc: ProcessDocument<AgentState, AgentControl>, events: AgentEvent[]) => void
  ): Unsubscribe {
    let last: string | undefined;
    let stopped = false;
    let busy: Promise<void> = Promise.resolve();
    const check = () => {
      busy = busy.then(async () => {
        if (stopped) return;
        const doc = await this.readLegacy();
        if (!doc) return;
        const sig = JSON.stringify([doc.state, doc.lifecycle.status, doc.control]);
        if (sig === last) return;
        const first = last === undefined;
        last = sig;
        if (first) return; // current document was delivered by readDocument()
        this.mirrorVersion++;
        cb({ ...doc, version: this.mirrorVersion }, []);
      });
    };
    check();
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(this.dir, (_e, name) => {
        if (!name || name === "metadata.json" || name === "status.txt") check();
      });
      watcher.on("error", () => {});
      (watcher as any).unref?.();
    } catch {
      // hint only
    }
    const timer = setInterval(check, 1000);
    (timer as any).unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
    };
  }

  async writeControl(patch: Partial<AgentControl>): Promise<void> {
    if (patch.desired) {
      const text =
        patch.desired === "cancelled" ? "killed" : patch.desired === "paused" ? "paused" : "running";
      await fs.promises.writeFile(this.statusPath, text, "utf8");
    }
    if (patch.interrupt) {
      appendInput(this.inputPath, { text: `/poke ${patch.interrupt.message || ""}`.trim() });
    }
    if (patch.compact) appendInput(this.inputPath, { text: "/compact" });
  }

  async appendInput(item: {
    id?: string;
    kind?: string;
    text?: string;
    payload?: unknown;
    from?: string;
  }): Promise<void> {
    const payload: any = item.payload;
    appendInput(this.inputPath, {
      ...item,
      text: item.text ?? (typeof payload === "string" ? payload : payload?.text),
      payload: item.text === undefined && payload?.text === undefined ? payload : undefined,
    });
  }
}

/** Synthesize a ProcessDocument from the legacy metadata.json / status.txt pair. */
export function docFromLegacy(
  taskId: string,
  meta: any,
  statusText: string | undefined,
  version = 1
): ProcessDocument<AgentState, AgentControl> {
  const raw = statusText || meta.status;
  const status: ProcessStatus =
    raw === "completed" || (!raw && meta.inProgress === false)
      ? "completed"
      : raw === "killed"
        ? "cancelled"
        : raw === "failed" || raw === "error"
          ? "failed"
          : raw === "paused"
            ? "paused"
            : "running";
  const metaStatus: string | undefined = meta.status;
  // a task whose metadata says terminal wins over a stale status.txt
  const finalStatus: ProcessStatus =
    metaStatus === "completed" ? "completed" : metaStatus === "killed" ? "cancelled" : status;
  const now = meta.lastUpdate ?? new Date().toISOString();
  const links: Record<string, string> = {};
  if (meta.remoteTaskId || meta.knowhowTaskId) {
    links.remoteTaskId = meta.remoteTaskId || meta.knowhowTaskId;
  }
  return {
    meta: {
      id: meta.taskId ?? taskId,
      kind: "agent",
      name: meta.agentName,
      parentId: meta.parentTaskId,
      createdAt: meta.startTime ?? now,
      schemaVersion: 1,
      links,
    },
    state: {
      agentName: meta.agentName ?? taskId,
      model: meta.model,
      provider: meta.provider,
      reasoningEffort: meta.reasoningEffort,
      summarizeReasoning: meta.summarizeReasoning,
      enabledTools: meta.enabledTools ?? [],
      threads: meta.threads ?? [],
      totalCostUsd: meta.totalCostUsd ?? 0,
      tokenUsage: meta.tokenUsage ?? {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
      },
      prompt: meta.prompt ?? "",
      pendingUserMessages: meta.pendingUserMessages ?? [],
      inputCursors: meta.inputCursor ? { fs: meta.inputCursor } : {},
      result: meta.result,
    },
    control:
      statusText === "paused"
        ? { desired: "paused" }
        : statusText === "killed"
          ? { desired: "cancelled" }
          : {},
    lifecycle: {
      status: finalStatus,
      updatedAt: now,
      resumable: "replay",
      result: meta.result,
    },
    version,
    controlVersion: 0,
    observedControlVersion: 0,
  };
}

/**
 * State to carry over when a task directory is reused (resume): the input
 * cursor (nothing is replayed) and consumed-but-unplaced user messages.
 */
export async function loadAgentRestoreState(
  taskId: string,
  baseDir = AGENTS_DIR
): Promise<{ inputCursors?: Record<string, unknown>; pendingUserMessages?: any[] } | undefined> {
  const meta = await readJsonFile<any>(path.join(baseDir, taskId, "metadata.json"));
  if (!meta) return undefined;
  const cursor = meta.inputCursor;
  return {
    inputCursors:
      cursor && typeof cursor.offset === "number" ? { fs: cursor } : undefined,
    pendingUserMessages: Array.isArray(meta.pendingUserMessages)
      ? meta.pendingUserMessages
      : undefined,
  };
}
