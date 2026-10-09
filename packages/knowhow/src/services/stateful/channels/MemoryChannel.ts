import type { BaseControl, ProcessDocument, Unsubscribe } from "../types";
import { DuplexChannel } from "./base";
import type { DocSource, OutputPolicy } from "./Channel";

/**
 * In-memory duplex channel: for tests and in-process mirrors. Keeps the last
 * published document, notifies watchers, and lets a mirror write control and
 * inputs (which reach the process through the normal input path).
 */
export class MemoryChannel<S = any, C extends BaseControl = BaseControl, E = any>
  extends DuplexChannel<S, C, E>
  implements DocSource<S, C, E>
{
  readonly id: string;
  doc?: ProcessDocument<S, C>;
  /** every publish (version + events), when `record` is set */
  publishes: Array<{ version: number; events: E[] }> = [];
  private watchers = new Set<(doc: ProcessDocument<S, C>, events: E[]) => void>();
  private seq = 0;

  constructor(
    private opts: { id?: string; policy?: OutputPolicy; record?: boolean; publish?: (doc: ProcessDocument<S, C>, events: E[]) => void | Promise<void> } = {}
  ) {
    super();
    this.id = opts.id ?? "memory";
    this.policy = opts.policy;
  }

  async publish(doc: ProcessDocument<S, C>, events: E[]): Promise<void> {
    await this.opts.publish?.(doc, events); // test hook (slow / failing channels)
    this.doc = doc;
    if (this.opts.record) this.publishes.push({ version: doc.version, events });
    for (const w of [...this.watchers]) w(doc, events);
  }

  async readDocument(): Promise<ProcessDocument<S, C> | undefined> {
    // before the first publish landed, the owner's current snapshot IS the full snapshot
    return this.doc ?? this.ctx?.snapshot();
  }

  watchDocument(cb: (doc: ProcessDocument<S, C>, events: E[]) => void): Unsubscribe {
    this.watchers.add(cb);
    return () => {
      this.watchers.delete(cb);
    };
  }

  async writeControl(patch: Partial<C>): Promise<void> {
    if (!this.ctx) throw new Error("MemoryChannel is not attached");
    this.ctx.applyControl(patch);
  }

  async appendInput(item: {
    id?: string;
    kind?: string;
    text?: string;
    payload?: unknown;
    from?: string;
  }): Promise<void> {
    if (!this.ctx) throw new Error("MemoryChannel is not attached");
    await this.ctx.deliver(
      [
        {
          id: item.id ?? `mem-${this.seq + 1}`,
          kind: item.kind ?? "message",
          payload: item.payload !== undefined ? item.payload : { text: item.text },
          at: new Date().toISOString(),
          from: item.from,
        },
      ],
      ++this.seq
    );
  }

  async stop(): Promise<void> {
    this.watchers.clear();
  }
}
