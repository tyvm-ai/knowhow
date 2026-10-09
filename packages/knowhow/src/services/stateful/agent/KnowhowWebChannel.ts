import { DuplexChannel } from "../channels/base";
import { ThreadCursor } from "../channels/delta";
import type { OutputPolicy } from "../channels/Channel";
import type { ProcessDocument } from "../types";
import { isTerminalStatus } from "../types";
import type { Message } from "../../../clients/types";
import {
  KnowhowSimpleClient,
  TaskStatusFields,
  TaskThreadWriteResponse,
} from "../../KnowhowClient";
import type { AgentControl, AgentEvent, AgentState } from "./types";

type Doc = ProcessDocument<AgentState, AgentControl>;

export interface KnowhowWebChannelOptions {
  /** Create a fresh remote task from this chat message... */
  messageId?: string;
  /** ...or attach to an existing remote task. */
  remoteTaskId?: string;
  client?: KnowhowSimpleClient;
  /** idle poll for pending messages / pause / kill (default 3000ms) */
  pollMs?: number;
  policy?: OutputPolicy;
}

const httpStatus = (e: any): number | undefined => e?.status ?? e?.response?.status;

function statusToControl(status?: string): Partial<AgentControl> | undefined {
  if (status === "killed") return { desired: "cancelled" };
  if (status === "paused") return { desired: "paused" };
  if (status === "running") return { desired: "running" };
  return undefined;
}

/**
 * Duplex channel to knowhow-web agent tasks.
 *  - start(): create the task (messageId) or attach to an existing one; records
 *    `remoteTaskId` as a process link.
 *  - publish: per-thread `POST .../threads/:i/append` and `PUT .../threads/:i`
 *    through a ThreadCursor (O(new messages)); 409 -> replace that thread;
 *    404/405 (old server) -> full PUT of all threads from then on.
 *  - input: `pendingMessages` from write responses (+ idle poll) are delivered
 *    as inputs and marked processed only after the consumption is persisted.
 *  - control: the task status (paused / killed / running) is edge-triggered.
 */
export class KnowhowWebChannel extends DuplexChannel<AgentState, AgentControl, AgentEvent> {
  readonly id = "web";
  private client: KnowhowSimpleClient;
  private remoteTaskId?: string;
  private cursor = new ThreadCursor<Message>();
  private legacyServer = false;
  private disabled = false;
  private errorLogged = false;
  private lastStatus?: string;
  private lastSent?: string;
  private lastWriteAt = 0;
  private lastDoc?: Doc;
  private handled = new Set<string>();
  private toMark = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private opts: KnowhowWebChannelOptions) {
    super();
    this.client = opts.client ?? new KnowhowSimpleClient();
    this.remoteTaskId = opts.remoteTaskId;
    this.policy = opts.policy ?? { minIntervalMs: 1000 };
  }

  static create(opts: Omit<KnowhowWebChannelOptions, "remoteTaskId"> & { messageId: string }) {
    return new KnowhowWebChannel(opts);
  }
  static existing(remoteTaskId: string, opts: Omit<KnowhowWebChannelOptions, "remoteTaskId" | "messageId"> = {}) {
    return new KnowhowWebChannel({ ...opts, remoteTaskId });
  }

  get taskId(): string | undefined {
    return this.remoteTaskId;
  }

  private reportOnce(message: string, error: unknown) {
    if (this.errorLogged) return;
    this.errorLogged = true;
    this.ctx?.log.error(`${message} ${(error as any)?.message ?? error}`);
  }

  protected async onStart(): Promise<void> {
    this.stopped = false;
    if (!this.remoteTaskId) {
      try {
        const doc = this.ctx.snapshot();
        const res = await this.client.createChatTask({
          messageId: this.opts.messageId!,
          prompt: doc.state.prompt,
        });
        this.remoteTaskId = res.data.id;
        if (this.opts.messageId) this.ctx.setLink("remoteMessageId", this.opts.messageId);
      } catch (e) {
        // optional sync service: stay quiet after the first failure
        this.disabled = true;
        this.reportOnce("Failed to create Knowhow chat task:", e);
        return;
      }
    }
    this.ctx.setLink("remoteTaskId", this.remoteTaskId!);
    this.timer = setInterval(() => void this.idlePoll(), this.opts.pollMs ?? 3000);
    (this.timer as any).unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.chain.catch(() => {});
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  // ---- out ------------------------------------------------------------------------

  private statusFields(doc: Doc): TaskStatusFields {
    const terminal = isTerminalStatus(doc.lifecycle.status);
    const result = doc.lifecycle.result;
    return {
      inProgress: !terminal,
      totalUsdCost: doc.state.totalCostUsd,
      ...(terminal && result !== undefined ? { result } : {}),
    };
  }

  async publish(doc: Doc, _events: AgentEvent[]): Promise<void> {
    if (this.disabled || !this.remoteTaskId) return;
    this.lastDoc = doc;
    await this.serial(() => this.write(doc));
  }

  private async write(doc: Doc): Promise<void> {
    try {
      await this.writeThreads(doc);
    } catch (e) {
      const code = httpStatus(e);
      const reason = (e as any)?.body?.reason ?? (e as any)?.body?.errors?.reason;
      if (code === 404 || code === 405) {
        this.legacyServer = true; // old server: full PUT from now on
      } else if (!(code === 409 && reason === "inline_storage")) {
        throw e;
      }
      await this.writeFull(doc, this.statusFields(doc));
    }
  }

  private async writeThreads(doc: Doc): Promise<void> {
    const id = this.remoteTaskId!;
    const threads = doc.state.threads;
    const fields = this.statusFields(doc);
    const fieldsKey = JSON.stringify(fields);

    if (this.legacyServer) return this.writeFull(doc, fields);

    const steps = this.cursor.plan(threads);
    if (!steps.length) {
      if (fieldsKey === this.lastSent) return;
      // status-only write: empty append to the last thread (a no-op for the threads)
      const index = Math.max(0, threads.length - 1);
      const length = this.cursor.view(index).length;
      try {
        await this.send(() =>
          this.client.appendTaskThread(id, index, { ...fields, length, messages: [] })
        );
      } catch (e) {
        if (httpStatus(e) !== 409) throw e;
        // the server's thread differs from what we believe: replace it
        const thread = threads[index] ?? [];
        this.cursor.reset(index);
        await this.send(() =>
          this.client.replaceTaskThread(id, index, { ...fields, messages: thread })
        );
        this.cursor.ackStep({ index, kind: "replace", items: thread }, thread);
      }
      this.lastSent = fieldsKey;
      return;
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const thread = threads[step.index] ?? [];
      const last = i === steps.length - 1;
      const status = last ? fields : {};
      try {
        if (step.kind === "append") {
          await this.send(() =>
            this.client.appendTaskThread(id, step.index, {
              ...status,
              length: thread.length,
              messages: step.items,
            })
          );
        } else {
          await this.send(() =>
            this.client.replaceTaskThread(id, step.index, { ...status, messages: thread })
          );
        }
        this.cursor.ackStep(step, thread);
      } catch (e) {
        const code = httpStatus(e);
        if (code === 404 || code === 405) {
          this.legacyServer = true; // old server: full PUT from now on
          return this.writeFull(doc, fields);
        }
        if (code === 409) {
          const reason = (e as any)?.body?.reason ?? (e as any)?.body?.errors?.reason;
          if (reason === "inline_storage") return this.writeFull(doc, fields);
          // server disagrees about this thread: replace it and carry on
          this.cursor.reset(step.index);
          await this.send(() =>
            this.client.replaceTaskThread(id, step.index, { ...status, messages: thread })
          );
          this.cursor.ackStep({ index: step.index, kind: "replace", items: thread }, thread);
        } else {
          throw e;
        }
      }
    }
    this.lastSent = fieldsKey;
  }

  /** Full-snapshot PUT (old servers, inline-stored tasks). */
  private async writeFull(doc: Doc, fields: TaskStatusFields): Promise<void> {
    const id = this.remoteTaskId!;
    await this.client.updateChatTask(id, {
      threads: doc.state.threads,
      totalUsdCost: fields.totalUsdCost ?? 0,
      inProgress: fields.inProgress ?? true,
      ...(fields.result !== undefined ? { result: fields.result } : {}),
    });
    doc.state.threads.forEach((t, i) =>
      this.cursor.ackStep({ index: i, kind: "replace", items: t }, t)
    );
    this.lastSent = JSON.stringify(fields);
  }

  /** One write; its response carries pending messages and the task status. */
  private async send(call: () => Promise<{ data: TaskThreadWriteResponse }>): Promise<void> {
    const res = await call();
    this.lastWriteAt = Date.now();
    await this.onResponse(res.data);
  }

  // ---- in -------------------------------------------------------------------------

  private async onResponse(r: TaskThreadWriteResponse | undefined): Promise<void> {
    if (!r) return;
    this.observeStatus(r.status);
    if (r.pendingMessages?.length) await this.deliverPending(r.pendingMessages);
    await this.markPending();
  }

  private observeStatus(status?: string) {
    if (status === undefined || status === this.lastStatus) return;
    const first = this.lastStatus === undefined;
    this.lastStatus = status;
    if (first) return; // baseline
    const patch = statusToControl(status);
    if (patch) this.ctx.applyControl(patch);
  }

  private async deliverPending(
    pending: Array<{ id: string; message: string; role: string; createdAt?: any }>
  ): Promise<void> {
    const fresh = pending.filter((m) => !this.handled.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) this.handled.add(m.id);
    const items = fresh.map((m) => ({
      id: m.id,
      kind: "message",
      payload: { text: m.message, role: m.role },
      at: new Date(m.createdAt ?? Date.now()).toISOString(),
    }));
    const version = await this.ctx.deliver(items, fresh[fresh.length - 1].id);
    // mark processed only once the consumption is durable locally. Never wait
    // on this channel's own pump here: we may be inside its publish().
    try {
      await this.ctx.persisted(version, "fs");
    } catch {
      // no local durable channel: the cursor in state is all there is
    }
    for (const m of fresh) this.toMark.add(m.id);
  }

  private async markPending(): Promise<void> {
    if (!this.toMark.size || !this.remoteTaskId) return;
    const ids = [...this.toMark];
    try {
      await this.client.markMessagesAsProcessed(this.remoteTaskId, ids);
      ids.forEach((i) => this.toMark.delete(i));
    } catch (e) {
      this.reportOnce("Failed to mark messages processed:", e);
    }
  }

  private async idlePoll(): Promise<void> {
    if (this.stopped || this.disabled || !this.remoteTaskId || !this.lastDoc) return;
    if (Date.now() - this.lastWriteAt < (this.opts.pollMs ?? 3000)) return;
    if (isTerminalStatus(this.ctx.snapshot().lifecycle.status)) return;
    await this.serial(async () => {
      try {
        const doc = this.ctx.snapshot();
        if (this.legacyServer) {
          const id = this.remoteTaskId!;
          const details = (await this.client.getTaskDetails(id)).data;
          this.observeStatus(details.status);
          const pending = (await this.client.getPendingMessages(id)).data ?? [];
          await this.deliverPending(pending as any);
          await this.markPending();
        } else {
          // a no-op write: the response has status + pending messages
          const index = Math.max(0, doc.state.threads.length - 1);
          const length = this.cursor.view(index).length;
          await this.send(() =>
            this.client.appendTaskThread(this.remoteTaskId!, index, {
              ...this.statusFields(doc),
              length,
              messages: [],
            })
          );
        }
      } catch (e) {
        this.reportOnce("Error polling Knowhow task:", e);
      }
    });
  }
}
