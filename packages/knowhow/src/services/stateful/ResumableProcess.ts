import type { Channel, DocSource } from "./channels/Channel";
import { ProcessInit, StatefulProcess } from "./StatefulProcess";
import type { BaseControl, ProcessDocument } from "./types";

/**
 * A process that can continue from a persisted document. Minimal on purpose:
 * `start()` is a fresh run, `resumeFrom(doc)` (not `resume`: that is the control method) continues (must be safe after a crash),
 * `ResumableProcess.load()` restores state from a document and re-attaches
 * channels (their first publish carries the full state, so mirrors see
 * "resumed"; input/control channels deliver whatever arrived while nobody
 * owned the process, from the cursor stored in state).
 *
 * Subclass constructors must accept a `ProcessInit` (load calls
 * `new Class({ kind, document })`).
 */
export abstract class ResumableProcess<
  S = any,
  C extends BaseControl = BaseControl,
  E = never,
> extends StatefulProcess<S, C, E> {
  abstract start(input: unknown): Promise<unknown>;
  protected abstract resumeFrom(doc: ProcessDocument<S, C>): Promise<unknown>;

  /** Continue the loaded process under `run()` (running/completed/failed + flush). */
  resumeRun(): Promise<unknown> {
    return this.run(() => this.resumeFrom(this.snapshot()));
  }

  static async load<P extends ResumableProcess<any, any, any>>(
    this: new (init: ProcessInit<any, any>) => P,
    from: ProcessDocument | Pick<DocSource, "readDocument">,
    opts: { channels?: Channel[] } = {}
  ): Promise<P> {
    const doc: ProcessDocument | undefined =
      "meta" in from ? from : await from.readDocument();
    if (!doc) throw new Error("ResumableProcess.load: no document found");
    const p = new this({ kind: doc.meta.kind, document: doc });
    for (const ch of opts.channels ?? []) await p.attach(ch);
    return p;
  }
}
