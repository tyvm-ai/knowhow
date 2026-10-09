import { EventService } from "../../EventService";
import { KnowhowSimpleClient } from "../../KnowhowClient";
import type { SyncedAgentWatcher, AttachableAgent } from "../../SyncedAgentWatcher";
import { WatcherBackedAgent } from "../../SyncedAgentWatcher";
import type { DocSource } from "../channels/Channel";
import { ProcessMirror } from "../ProcessMirror";
import type { ProcessDocument, ProcessStatus, Unsubscribe } from "../types";
import { AgentFsChannel } from "./AgentFsChannel";
import { PROJECTION_EVENT_TYPES, agentProjection } from "./agentProjection";
import type { AgentControl, AgentEvent, AgentState } from "./types";

type Doc = ProcessDocument<AgentState, AgentControl>;
export type AgentMirror = ProcessMirror<AgentState, AgentControl, AgentEvent>;

/** DocSource over a knowhow-web agent task (polls GET details; control/inputs via the task API). */
export class KnowhowWebSource implements DocSource<AgentState, AgentControl, AgentEvent> {
  private version = 0;

  constructor(
    private taskId: string,
    private client: KnowhowSimpleClient = new KnowhowSimpleClient(),
    private pollMs = 3000
  ) {}

  private toDoc(d: any): Doc {
    const raw: string | undefined = d.status;
    const status: ProcessStatus =
      raw === "completed" || (!raw && d.inProgress === false)
        ? "completed"
        : raw === "killed"
          ? "cancelled"
          : raw === "paused"
            ? "paused"
            : "running";
    const now = d.updatedAt ?? new Date().toISOString();
    return {
      meta: {
        id: this.taskId,
        kind: "agent",
        name: "remote-agent",
        createdAt: d.createdAt ?? now,
        schemaVersion: 1,
        links: { remoteTaskId: this.taskId },
      },
      state: {
        agentName: "remote-agent",
        model: "",
        provider: "",
        enabledTools: [],
        threads: d.threads ?? [],
        totalCostUsd: d.totalUsdCost ?? 0,
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
        },
        prompt: "",
        pendingUserMessages: [],
        inputCursors: {},
        result: d.result,
      },
      control:
        raw === "paused" ? { desired: "paused" } : raw === "killed" ? { desired: "cancelled" } : {},
      lifecycle: { status, updatedAt: now, resumable: "none", result: d.result },
      version: this.version,
      controlVersion: 0,
      observedControlVersion: 0,
    };
  }

  async readDocument(): Promise<Doc | undefined> {
    const res = await this.client.getTaskDetails(this.taskId);
    this.version = Math.max(this.version, 1);
    return this.toDoc(res?.data ?? {});
  }

  watchDocument(cb: (doc: Doc, events: AgentEvent[]) => void): Unsubscribe {
    let last: string | undefined;
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const res = await this.client.getTaskDetails(this.taskId);
        const doc = this.toDoc(res?.data ?? {});
        const sig = JSON.stringify([doc.state, doc.lifecycle.status]);
        const first = last === undefined;
        if (sig !== last) {
          last = sig;
          if (!first) {
            this.version++;
            cb({ ...doc, version: this.version }, []);
          }
        }
      } catch {
        // keep polling through transient errors
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(poll, this.pollMs);
    (timer as any).unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async writeControl(patch: Partial<AgentControl>): Promise<void> {
    if (patch.desired === "paused") await this.client.pauseAgent(this.taskId);
    else if (patch.desired === "running") await this.client.resumeAgent(this.taskId);
    else if (patch.desired === "cancelled") await this.client.killAgent(this.taskId);
    if (patch.interrupt) {
      await this.client.sendMessageToAgent(
        this.taskId,
        `/poke ${patch.interrupt.message || ""}`.trim()
      );
    }
    if (patch.compact) await this.client.sendMessageToAgent(this.taskId, "/compact");
  }

  async appendInput(item: { text?: string; payload?: unknown }): Promise<void> {
    const p: any = item.payload;
    const text = item.text ?? (typeof p === "string" ? p : p?.text) ?? "";
    await this.client.sendMessageToAgent(this.taskId, text);
  }
}

/**
 * SyncedAgentWatcher implemented once on top of a ProcessMirror + the shared
 * agentProjection. The fs and web watchers differ only in their DocSource.
 */
export class MirrorAgentWatcher implements SyncedAgentWatcher {
  public taskId = "";
  public agentName = "unknown";
  public agentEvents = new EventService();
  public eventTypes = { ...PROJECTION_EVENT_TYPES };
  protected mirror?: AgentMirror;
  private stopProjection?: () => void;

  constructor(private makeSource?: (taskId: string) => DocSource<AgentState, AgentControl, AgentEvent>) {}

  /** Follow an already-open mirror. */
  attach(mirror: AgentMirror): void {
    this.mirror = mirror;
    this.taskId = mirror.meta.id;
    this.agentName = mirror.getState().agentName || this.taskId;
    this.stopProjection = agentProjection(mirror, this.agentEvents, {
      types: this.eventTypes,
      onDone: () => this.stopWatching(),
    });
  }

  async startWatching(taskId: string): Promise<void> {
    this.taskId = taskId;
    const source = this.makeSource!(taskId);
    this.attach(await ProcessMirror.open(source));
    this.onStarted();
  }

  protected onStarted(): void {
    console.log(`👁️  Watching agent: ${this.taskId} (${this.agentName})`);
    console.log(`   Type /logs 20 to see recent messages, or type to send a message`);
  }

  stopWatching(): void {
    this.stopProjection?.();
    this.stopProjection = undefined;
    this.mirror?.close();
    console.log(`🔌 Stopped watching agent: ${this.taskId}`);
  }

  async sendMessage(message: string): Promise<void> {
    await this.mirror!.send("message", { text: message });
  }
  async getThreads(): Promise<any[][]> {
    return this.mirror?.getState().threads ?? [];
  }
  async pause() {
    await this.mirror!.pause();
  }
  async unpause() {
    await this.mirror!.resume();
  }
  async kill() {
    await this.mirror!.cancel();
  }
  async interrupt(message?: string) {
    await this.mirror!.interrupt(message);
  }
}

/** Attach to a local agent task directory (another process owns it). */
export class FsSyncedAgentWatcher extends MirrorAgentWatcher {
  constructor() {
    super((taskId) => new AgentFsChannel({ taskId }));
  }
}

/** Attach to a knowhow-web agent task. */
export class WebSyncedAgentWatcher extends MirrorAgentWatcher {
  constructor(client?: KnowhowSimpleClient) {
    super((taskId) => new KnowhowWebSource(taskId, client));
  }
  protected onStarted(): void {
    this.agentName = "remote-agent";
    console.log(`🌐 Watching web-synced agent: ${this.taskId} (${this.agentName})`);
    console.log(`   Type /logs 20 to see recent messages, or type to send a message`);
  }
}

/** Adapt an open mirror to the interface the attached chat loop drives. */
export function asAttachable(mirror: AgentMirror): AttachableAgent {
  const watcher = new MirrorAgentWatcher();
  watcher.attach(mirror);
  return new WatcherBackedAgent(watcher);
}
