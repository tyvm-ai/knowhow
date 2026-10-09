import { randomUUID } from "crypto";
import type { DocSource } from "./channels/Channel";
import { changesIterable } from "./changesIterable";
import {
  BaseControl,
  ControlChange,
  Lifecycle,
  ProcessDocument,
  ProcessHandle,
  ProcessMeta,
  StateChange,
  Unsubscribe,
  isTerminalStatus,
} from "./types";

/**
 * Read side of any process, fed by a `DocSource` (memory channel, fs dir, ...).
 * Not a StatefulProcess: it has the same READ surface and the EXTERNAL write
 * surface (control + inputs, routed through the source), but no owner writes.
 * `getState()` only ever changes because the source delivered a newer document.
 *
 * Writes are asynchronous requests; use `isControlObserved()` /
 * `getDocument().observedControlVersion` to show "pausing…" vs "paused".
 */
export class ProcessMirror<S = any, C extends BaseControl = BaseControl, E = any>
  implements ProcessHandle<S, C, E>
{
  private doc: ProcessDocument<S, C>;
  private stateListeners = new Set<(c: StateChange<S, E>) => void>();
  private controlListeners = new Set<(c: ControlChange<C>) => void>();
  private unwatch?: Unsubscribe;

  private constructor(
    private source: DocSource<S, C, E>,
    doc: ProcessDocument<S, C>
  ) {
    this.doc = doc;
    this.unwatch = source.watchDocument((d, events) => this.ingest(d, events));
  }

  /** Read the current document (full snapshot) and start following it. */
  static async open<S = any, C extends BaseControl = BaseControl, E = any>(
    source: DocSource<S, C, E>
  ): Promise<ProcessMirror<S, C, E>> {
    const doc = await source.readDocument();
    if (!doc) throw new Error("ProcessMirror.open: source has no document");
    return new ProcessMirror(source, doc);
  }

  private ingest(next: ProcessDocument<S, C>, events: E[]) {
    const prev = this.doc;
    const newer =
      next.version > prev.version ||
      next.controlVersion > prev.controlVersion ||
      next.observedControlVersion > prev.observedControlVersion;
    if (!newer) return; // stale or duplicate
    this.doc = next;
    if (next.controlVersion > prev.controlVersion) {
      const change: ControlChange<C> = {
        controlVersion: next.controlVersion,
        prev: prev.control,
        next: next.control,
        source: "source",
      };
      for (const cb of [...this.controlListeners]) this.safe(() => cb(change));
    }
    if (next.version > prev.version || events.length) {
      const change: StateChange<S, E> = {
        version: next.version,
        prev: prev.state,
        next: next.state,
        events,
      };
      for (const cb of [...this.stateListeners]) this.safe(() => cb(change));
    }
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch {
      // listener errors never break the mirror
    }
  }

  get meta(): ProcessMeta {
    return this.doc.meta;
  }
  getState(): Readonly<S> {
    return this.doc.state;
  }
  getControl(): Readonly<C> {
    return this.doc.control;
  }
  getLifecycle(): Readonly<Lifecycle> {
    return this.doc.lifecycle;
  }
  getDocument(): ProcessDocument<S, C> {
    return this.doc;
  }
  /** false while the owner has not yet applied the latest control ("pausing…"). */
  isControlObserved(): boolean {
    return this.doc.observedControlVersion >= this.doc.controlVersion;
  }

  onStateUpdated(cb: (c: StateChange<S, E>) => void): Unsubscribe {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }
  onControlUpdated(cb: (c: ControlChange<C>) => void): Unsubscribe {
    this.controlListeners.add(cb);
    return () => {
      this.controlListeners.delete(cb);
    };
  }
  changes(signal?: AbortSignal): AsyncIterable<StateChange<S, E>> {
    return changesIterable<StateChange<S, E>>(
      (cb) => this.onStateUpdated(cb),
      () => isTerminalStatus(this.doc.lifecycle.status),
      signal
    );
  }

  // ---- external writes: control and inputs only ----
  async applyControl(patch: Partial<C> | ((c: C) => C)): Promise<void> {
    const p =
      typeof patch === "function"
        ? (patch as (c: C) => C)(structuredClone(this.doc.control))
        : patch;
    await this.source.writeControl(p);
  }
  async send(
    kind: string,
    payload: unknown,
    opts: { id?: string; from?: string } = {}
  ): Promise<void> {
    await this.source.appendInput({ kind, payload, id: opts.id, from: opts.from });
  }
  pause(): Promise<void> {
    return this.applyControl({ desired: "paused" } as Partial<C>);
  }
  resume(): Promise<void> {
    return this.applyControl({ desired: "running" } as Partial<C>);
  }
  cancel(): Promise<void> {
    return this.applyControl({ desired: "cancelled" } as Partial<C>);
  }
  interrupt(message?: string): Promise<void> {
    return this.applyControl({ interrupt: { id: randomUUID(), message } } as Partial<C>);
  }

  close(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }
}
