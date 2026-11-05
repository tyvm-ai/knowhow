import { OutputChannel } from "../channels/base";
import type { ChannelContext } from "../channels/Channel";
import type { ProcessDocument } from "../types";
import { isTerminalStatus } from "../types";
import { getConfig } from "../../../config";
import { KnowhowSimpleClient } from "../../KnowhowClient";
import { WorkingSetSyncer, WORKING_SET_FLUSH_TIMEOUT_MS } from "../../WorkingSetSync";
import type { AgentControl, AgentEvent, AgentState } from "./types";

type Doc = ProcessDocument<AgentState, AgentControl>;

export interface WorkingSetSyncChannelOptions {
  client?: KnowhowSimpleClient;
  cwd?: string;
  baseDir?: string;
}

/**
 * Output-only channel that keeps the task's working set (uncommitted + unpushed
 * git state) uploaded while the task is synced to a remote task. Attached
 * next to the KnowhowWebChannel. It never writes state and never fails the
 * process: every publish returns immediately (the real work is a throttled,
 * single-flight background job in WorkingSetSyncer), except the terminal publish,
 * which flushes the final working set (bounded by WORKING_SET_FLUSH_TIMEOUT_MS).
 */
export class WorkingSetSyncChannel extends OutputChannel<AgentState, AgentControl, AgentEvent> {
  readonly id = "workingset";
  private syncer?: WorkingSetSyncer;
  private cachedConfig?: ReturnType<typeof configOf>;

  constructor(private opts: WorkingSetSyncChannelOptions = {}) {
    super();
    // never part of persisted(); no retries (the syncer has its own backoff)
    this.policy = { durable: false, retry: { attempts: 1, backoffMs: 0 } };
  }

  async start(ctx: ChannelContext<AgentState, AgentControl, AgentEvent>): Promise<void> {
    await super.start(ctx);
    try {
      this.cachedConfig = configOf(await getConfig());
    } catch {
      this.cachedConfig = undefined;
    }
    const meta = ctx.meta;
    this.syncer = new WorkingSetSyncer({
      client: this.opts.client ?? new KnowhowSimpleClient(),
      localTaskId: meta.id,
      remoteTaskId: () =>
        (ctx.snapshot().meta.links as Record<string, string> | undefined)?.remoteTaskId,
      cwd: this.opts.cwd,
      baseDir: this.opts.baseDir,
      getConfig: () => this.cachedConfig?.workingSetSync,
      maxFileMb: this.cachedConfig?.maxFileMb,
      configFiles: this.cachedConfig?.files,
      log: ctx.log,
    });
  }

  async publish(doc: Doc, _events: AgentEvent[]): Promise<void> {
    const syncer = this.syncer;
    if (!syncer) return;
    try {
      if (isTerminalStatus(doc.lifecycle.status)) {
        await syncer.flush(WORKING_SET_FLUSH_TIMEOUT_MS);
      } else {
        syncer.notify();
      }
    } catch {
      /* never fail the process */
    }
  }

  async stop(): Promise<void> {
    await this.syncer?.stop();
  }
}

function configOf(c: Awaited<ReturnType<typeof getConfig>>) {
  return {
    workingSetSync: c?.workingSetSync,
    maxFileMb: c?.gitPlugin?.maxFileMb,
    files: c?.files,
  };
}
