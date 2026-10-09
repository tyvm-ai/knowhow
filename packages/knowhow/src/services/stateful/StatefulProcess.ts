import { randomUUID } from "crypto";
import * as os from "os";
import { Logger } from "../../logger";
import { changesIterable } from "./changesIterable";
import {
  Channel,
  ChannelContext,
  ChannelLogger,
  ChannelPump,
} from "./channels/Channel";
import {
  BaseControl,
  ControlChange,
  InputCursor,
  InputItem,
  Lifecycle,
  ProcessCancelledError,
  ProcessDocument,
  ProcessHandle,
  ProcessMeta,
  ProcessStatus,
  StateChange,
  Unsubscribe,
  isTerminalStatus,
} from "./types";

export interface ProcessInit<S, C extends BaseControl = BaseControl> {
  id?: string;
  kind: string;
  name?: string;
  parentId?: string;
  schemaVersion?: number;
  links?: Record<string, string>;
  /** initial state (default `{}`) */
  state?: S;
  control?: C;
  lifecycle?: Partial<Lifecycle>;
  /** restore from a persisted document (takes precedence over the fields above) */
  document?: ProcessDocument<S, C>;
  log?: ChannelLogger;
}

interface InputWaiter {
  filter?: { kind?: string };
  resolve: (i: InputItem) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const INBOX_LIMIT = 1000;

const clone = <T>(v: T): T =>
  v === undefined ? v : (structuredClone(v) as T);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A process owns its STATE and LIFECYCLE (only it writes them). Things outside
 * it may only change CONTROL (`applyControl`) and push INPUTS (`send` / input
 * channels). Channels copy the document out (output) and carry control/inputs
 * in (input).
 *
 * Semantics worth knowing:
 *  - `update()` is synchronous and in-memory; it commits one version and hands
 *    the new document to each output channel's pump. State/lifecycle/control
 *    objects are treated as immutable: every update replaces them, so docs
 *    queued in a pump are never mutated afterwards. Do not mutate what
 *    `getState()` returns.
 *  - `setStatus()` also commits a version (state unchanged, reason
 *    `status:<x>`), so observers and channels see lifecycle changes.
 *  - `emit()` publishes events without bumping the version.
 *  - Control is level-triggered and reconciled: `applyControl` bumps
 *    `controlVersion`, runs the hooks (sequentially, async), then sets
 *    `observedControlVersion`. A no-op patch (deep-equal) is ignored, so
 *    re-delivering the same control is harmless.
 *  - Pause: `desired:"paused"` -> `onPause()` runs; the lifecycle becomes
 *    "paused" at the next `checkpoint()` (or immediately if the subclass calls
 *    `setStatus("paused")` itself in `onPause`). Resume: `desired:"running"`
 *    -> `onResume()`; a paused lifecycle goes back to "running".
 *  - Cancel: `desired:"cancelled"` -> `onCancel()`; `checkpoint()` and
 *    `waitForInput()` throw `ProcessCancelledError`; `run()` records
 *    "cancelled".
 *  - Inputs: input channels call `deliver()` -> `onInput(items, cursor)`; the
 *    subclass calls `consume()`. Without an `onInput` override the default
 *    keeps items in an inbox for `waitForInput()` and advances the cursor.
 *    `consume()` writes the cursor to `state.inputCursors[source]` in the same
 *    version as the effect.
 */
export abstract class StatefulProcess<
  S = any,
  C extends BaseControl = BaseControl,
  E = never,
> implements ProcessHandle<S, C, E>
{
  private _meta: ProcessMeta;
  private _state: S;
  private _control: C;
  private _lifecycle: Lifecycle;
  private _version = 0;
  private _controlVersion = 0;
  private _observedControlVersion = 0;

  private _channels: Channel<S, C, E>[] = [];
  private pumps = new Map<string, ChannelPump<S, C, E>>();
  private stateListeners = new Set<(c: StateChange<S, E>) => void>();
  private controlListeners = new Set<(c: ControlChange<C>) => void>();
  private controlWaiters: Array<() => void> = [];
  private controlChain: Promise<void> = Promise.resolve();
  private inputChain: Promise<void> = Promise.resolve();
  private inbox: InputItem[] = [];
  private inputWaiters: InputWaiter[] = [];
  private localSeq = 0;
  protected log: ChannelLogger;

  constructor(init: ProcessInit<S, C>) {
    const now = new Date().toISOString();
    this.log = init.log ?? Logger.of("StatefulProcess");
    if (init.document) {
      const d = init.document;
      this._meta = clone(d.meta);
      this._state = clone(d.state);
      this._control = clone(d.control);
      this._lifecycle = clone(d.lifecycle);
      this._version = d.version;
      this._controlVersion = d.controlVersion;
      this._observedControlVersion = d.observedControlVersion;
    } else {
      this._meta = {
        id: init.id ?? randomUUID(),
        kind: init.kind,
        name: init.name,
        parentId: init.parentId,
        createdAt: now,
        schemaVersion: init.schemaVersion ?? 1,
        links: init.links,
      };
      this._state = init.state ?? ({} as S);
      this._control = init.control ?? ({} as C);
      this._lifecycle = {
        status: "created",
        updatedAt: now,
        resumable: "none",
        ...init.lifecycle,
      };
    }
  }

  get meta(): ProcessMeta {
    return this._meta;
  }

  // ---- read ----
  getState(): Readonly<S> {
    return this._state;
  }
  getControl(): Readonly<C> {
    return this._control;
  }
  getLifecycle(): Readonly<Lifecycle> {
    return this._lifecycle;
  }
  snapshot(): ProcessDocument<S, C> {
    return {
      meta: this._meta,
      state: this._state,
      control: this._control,
      lifecycle: this._lifecycle,
      version: this._version,
      controlVersion: this._controlVersion,
      observedControlVersion: this._observedControlVersion,
    };
  }

  // ---- owner writes ----

  /**
   * Commit one version. `mutate` receives a deep-cloned draft: mutate it in
   * place, or return a replacement state.
   */
  protected update(
    mutate: (draft: S) => void | S,
    opts: { events?: E[]; reason?: string } = {}
  ): void {
    const prev = this._state;
    const draft = clone(prev);
    const result = mutate(draft);
    const next = (result === undefined ? draft : result) as S;
    this._state = next;
    this._version++;
    this.afterCommit(prev, next, opts.events ?? [], opts.reason);
  }

  /**
   * Commit `next` as the new state WITHOUT cloning the previous one (for big
   * states built from a fresh copy, e.g. a thread snapshot). The caller must
   * not keep a reference it later mutates.
   */
  protected replaceState(
    next: S,
    opts: { events?: E[]; reason?: string } = {}
  ): void {
    const prev = this._state;
    this._state = next;
    this._version++;
    this.afterCommit(prev, next, opts.events ?? [], opts.reason);
  }

  /** Publish events without changing state (no version bump). */
  protected emit(...events: E[]): void {
    this.afterCommit(this._state, this._state, events, undefined, false);
  }

  protected setStatus(status: ProcessStatus, extra: Partial<Lifecycle> = {}): void {
    const now = new Date().toISOString();
    const prevStatus = this._lifecycle.status;
    const next: Lifecycle = {
      ...this._lifecycle,
      ...extra,
      status,
      updatedAt: now,
    };
    if (status === "running" && !next.startedAt) next.startedAt = now;
    if (isTerminalStatus(status) && !next.endedAt) next.endedAt = now;
    this._lifecycle = next;
    this._version++;
    this.afterCommit(this._state, this._state, [], `status:${status}`);
    if (prevStatus !== status) this.wakeControlWaiters();
  }

  /**
   * Acknowledge inputs: run `apply` (record each item's effect in state) and
   * advance the source cursor in ONE committed version.
   */
  protected consume(
    items: InputItem[],
    cursor: InputCursor,
    apply: (draft: S, items: InputItem[]) => void
  ): void {
    this.update(
      (draft) => {
        apply(draft, items);
        const d = draft as any;
        if (d && typeof d === "object") {
          d.inputCursors = { ...(d.inputCursors ?? {}), [cursor.source]: cursor.value };
        }
      },
      { reason: `consume:${cursor.source}` }
    );
  }

  private afterCommit(
    prev: S,
    next: S,
    events: E[],
    reason?: string,
    bumped = true
  ) {
    const doc = this.snapshot();
    for (const pump of this.pumps.values()) pump.enqueue(doc, events);
    const change: StateChange<S, E> = {
      version: this._version,
      prev,
      next,
      events,
      reason,
    };
    void bumped;
    for (const cb of [...this.stateListeners]) {
      try {
        cb(change);
      } catch (e: any) {
        this.log.error(`onStateUpdated listener failed: ${e?.message ?? e}`);
      }
    }
  }

  // ---- external writes ----

  applyControl(patch: Partial<C> | ((c: C) => C), source = "local"): void {
    const prev = this._control;
    const next: C =
      typeof patch === "function"
        ? (patch as (c: C) => C)(clone(prev))
        : ({ ...prev, ...patch } as C);
    if (same(prev, next)) return;
    this._control = next;
    const controlVersion = ++this._controlVersion;
    const change: ControlChange<C> = { controlVersion, prev, next, source };
    // publish the new control (observed still behind => "pausing…" is visible)
    const doc = this.snapshot();
    for (const pump of this.pumps.values()) pump.enqueue(doc, []);
    for (const cb of [...this.controlListeners]) {
      try {
        cb(change);
      } catch (e: any) {
        this.log.error(`onControlUpdated listener failed: ${e?.message ?? e}`);
      }
    }
    this.controlChain = this.controlChain.then(() => this.reconcile(change));
  }

  private async reconcile(change: ControlChange<C>): Promise<void> {
    const { prev, next } = change;
    const run = async (name: string, fn?: () => void | Promise<void>) => {
      if (!fn) return;
      try {
        await fn.call(this);
      } catch (e: any) {
        this.log.error(`${name} hook failed: ${e?.message ?? e}`);
      }
    };
    await run("onControl", () => this.onControl?.(change));
    if (next.desired !== prev.desired) {
      if (next.desired === "paused") await run("onPause", () => this.onPause?.());
      else if (next.desired === "cancelled") await run("onCancel", () => this.onCancel?.());
      else if (
        next.desired === "running" &&
        (prev.desired === "paused" || this._lifecycle.status === "paused")
      ) {
        await run("onResume", () => this.onResume?.());
        if (this._lifecycle.status === "paused" && this._control.desired !== "paused") {
          this.setStatus("running");
        }
      }
    }
    if (next.interrupt?.id && next.interrupt.id !== prev.interrupt?.id) {
      const message = next.interrupt.message;
      await run("onInterrupt", () => this.onInterrupt?.(message));
    }
    this._observedControlVersion = Math.max(
      this._observedControlVersion,
      change.controlVersion
    );
    const doc = this.snapshot();
    for (const pump of this.pumps.values()) pump.enqueue(doc, []);
    this.wakeControlWaiters();
    this.rejectInputWaitersIfCancelled();
  }

  /** Push an input from local code (goes through the in-memory input path). */
  send(
    kind: string,
    payload: unknown,
    opts: { id?: string; from?: string } = {}
  ): InputItem {
    const item: InputItem = {
      id: opts.id ?? randomUUID(),
      kind,
      payload,
      at: new Date().toISOString(),
      from: opts.from,
      source: "local",
    };
    this.localSeq++;
    this.enqueueDelivery("local", [item], this.localSeq);
    return item;
  }
  pause(): void {
    this.applyControl({ desired: "paused" } as Partial<C>);
  }
  resume(): void {
    this.applyControl({ desired: "running" } as Partial<C>);
  }
  cancel(): void {
    this.applyControl({ desired: "cancelled" } as Partial<C>);
  }
  interrupt(message?: string): void {
    this.applyControl({ interrupt: { id: randomUUID(), message } } as Partial<C>);
  }

  // ---- hooks ----
  protected onControl?(change: ControlChange<C>): void | Promise<void>;
  protected onPause?(): void | Promise<void>;
  protected onResume?(): void | Promise<void>;
  protected onCancel?(): void | Promise<void>;
  protected onInterrupt?(message?: string): void | Promise<void>;
  protected onInput?(items: InputItem[], cursor: InputCursor): void | Promise<void>;

  // ---- inputs ----
  private enqueueDelivery(
    source: string,
    items: Array<Omit<InputItem, "source"> & { id?: string; at?: string }>,
    cursor: unknown
  ): Promise<number> {
    const full: InputItem[] = items.map((i) => ({
      ...i,
      id: i.id ?? randomUUID(),
      at: i.at ?? new Date().toISOString(),
      source,
    }));
    const p = this.inputChain.then(async () => {
      try {
        await this.deliverInput(full, { source, value: cursor });
      } catch (e: any) {
        this.log.error(`onInput failed (${source}): ${e?.message ?? e}`);
      }
      return this._version;
    });
    this.inputChain = p.then(() => {});
    return p;
  }

  private async deliverInput(items: InputItem[], cursor: InputCursor) {
    if (!items.length && cursor.value === undefined) return;
    this.inbox.push(...items);
    // cursor-only deliveries (items = []) are recorded by the base class
    if (this.inbox.length > INBOX_LIMIT) {
      this.inbox.splice(0, this.inbox.length - INBOX_LIMIT);
    }
    if (this.onInput && items.length) {
      await this.onInput(items, cursor);
    } else {
      this.consume(items, cursor, () => {});
    }
    this.serveInputWaiters();
  }

  private serveInputWaiters() {
    for (const w of [...this.inputWaiters]) {
      const idx = this.inbox.findIndex(
        (i) => !w.filter?.kind || i.kind === w.filter.kind
      );
      if (idx < 0) continue;
      const [item] = this.inbox.splice(idx, 1);
      this.inputWaiters.splice(this.inputWaiters.indexOf(w), 1);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(item);
    }
  }

  private rejectInputWaitersIfCancelled() {
    if (this._control.desired !== "cancelled") return;
    for (const w of this.inputWaiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new ProcessCancelledError());
    }
  }

  /** Resolves with the next (matching) input item. Status is "waiting" meanwhile. */
  async waitForInput(
    filter: { kind?: string; timeoutMs?: number } = {}
  ): Promise<InputItem> {
    if (this._control.desired === "cancelled") throw new ProcessCancelledError();
    const wasRunning = this._lifecycle.status === "running";
    const idx = this.inbox.findIndex((i) => !filter.kind || i.kind === filter.kind);
    if (idx >= 0) return this.inbox.splice(idx, 1)[0];
    if (wasRunning) this.setStatus("waiting");
    try {
      return await new Promise<InputItem>((resolve, reject) => {
        const w: InputWaiter = { filter, resolve, reject };
        if (filter.timeoutMs !== undefined) {
          w.timer = setTimeout(() => {
            this.inputWaiters = this.inputWaiters.filter((x) => x !== w);
            reject(new Error(`waitForInput timed out after ${filter.timeoutMs}ms`));
          }, filter.timeoutMs);
          (w.timer as any).unref?.();
        }
        this.inputWaiters.push(w);
      });
    } finally {
      if (wasRunning && this._lifecycle.status === "waiting") this.setStatus("running");
    }
  }


  // ---- observe ----
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

  /**
   * Async iterator of committed changes. Ends on abort, or after the change
   * that made the lifecycle terminal (immediately if already terminal).
   */
  changes(signal?: AbortSignal): AsyncIterable<StateChange<S, E>> {
    return changesIterable<StateChange<S, E>>(
      (cb) => this.onStateUpdated(cb),
      () => isTerminalStatus(this._lifecycle.status),
      signal
    );
  }

  // ---- cooperative safe points ----
  private wakeControlWaiters() {
    const ws = this.controlWaiters.splice(0);
    for (const w of ws) w();
  }

  private nextControlChange(): Promise<void> {
    return new Promise<void>((r) => this.controlWaiters.push(r));
  }

  /**
   * Call at safe points. Resolves immediately when running; blocks while
   * `desired` is "paused" (lifecycle becomes "paused"); throws
   * `ProcessCancelledError` when cancelled. No polling: woken by control.
   */
  async checkpoint(): Promise<void> {
    for (;;) {
      const desired = this._control.desired;
      if (desired === "cancelled" || this._lifecycle.status === "cancelled") {
        throw new ProcessCancelledError();
      }
      if (desired === "paused") {
        if (this._lifecycle.status !== "paused" && !isTerminalStatus(this._lifecycle.status)) {
          this.setStatus("paused");
        }
        await this.nextControlChange();
        continue;
      }
      if (this._lifecycle.status === "paused") this.setStatus("running");
      return;
    }
  }

  // ---- channels ----
  private makeContext(channel: Channel<S, C, E>): ChannelContext<S, C, E> {
    return {
      meta: this._meta,
      snapshot: () => this.snapshot(),
      applyControl: (patch) => this.applyControl(patch, channel.id),
      deliver: (items, cursor) => this.enqueueDelivery(channel.id, items, cursor),
      cursor: () => (this._state as any)?.inputCursors?.[channel.id],
      persisted: (version, channelId) =>
        this.persisted(
          version,
          channelId ?? (channel.direction !== "in" ? channel.id : undefined)
        ),
      setLink: (key, value) => {
        this._meta = { ...this._meta, links: { ...this._meta.links, [key]: value } };
        const doc = this.snapshot();
        for (const pump of this.pumps.values()) pump.enqueue(doc, []);
      },
      log: this.log,
    };
  }

  /**
   * Attach a channel (also on a running process). Output/duplex channels get
   * the full current document as their first publish.
   */
  async attach(channel: Channel<S, C, E>): Promise<Unsubscribe> {
    if (this._channels.some((c) => c.id === channel.id)) {
      throw new Error(`channel ${channel.id} is already attached`);
    }
    this._channels.push(channel);
    let pump: ChannelPump<S, C, E> | undefined;
    if (channel.direction !== "in" && channel.publish) {
      pump = new ChannelPump(channel, this.log);
      this.pumps.set(channel.id, pump);
    }
    try {
      await channel.start(this.makeContext(channel));
    } catch (e) {
      this.removeChannel(channel);
      throw e;
    }
    pump?.enqueue(this.snapshot(), []);
    return () => {
      void this.detach(channel.id);
    };
  }

  private removeChannel(channel: Channel<S, C, E>) {
    this._channels = this._channels.filter((c) => c !== channel);
    this.pumps.delete(channel.id);
  }

  async detach(channelId: string): Promise<void> {
    const channel = this._channels.find((c) => c.id === channelId);
    if (!channel) return;
    const pump = this.pumps.get(channelId);
    this.removeChannel(channel);
    try {
      await pump?.stop();
      await channel.stop();
    } catch (e: any) {
      this.log.error(`channel ${channelId} stop failed: ${e?.message ?? e}`);
    }
  }

  channels(): readonly Channel<S, C, E>[] {
    return this._channels;
  }

  /** Await control hooks, input deliveries and every output channel's queue. */
  async flush(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.controlChain;
      const inputs = this.inputChain;
      await chain;
      await inputs;
    } while (chain !== this.controlChain);
    await Promise.all([...this.pumps.values()].map((p) => p.flush()));
  }

  /**
   * Resolves when `version` (or newer) has been persisted by channel
   * `channelId`, or by every durable output channel when no id is given.
   */
  persisted(version: number, channelId?: string): Promise<void> {
    if (channelId) {
      const pump = this.pumps.get(channelId);
      if (!pump) {
        return Promise.reject(new Error(`no output channel '${channelId}' attached`));
      }
      return pump.waitPersisted(version);
    }
    const durable = [...this.pumps.values()].filter((p) => p.durable);
    return Promise.all(durable.map((p) => p.waitPersisted(version))).then(() => {});
  }

  /** Flush, stop channels, clear the executor. */
  async close(): Promise<void> {
    if (this._lifecycle.executor) {
      this._lifecycle = { ...this._lifecycle, executor: undefined, updatedAt: new Date().toISOString() };
      this._version++;
      this.afterCommit(this._state, this._state, [], "close");
    }
    await this.flush();
    for (const c of [...this._channels]) await this.detach(c.id);
  }

  // ---- lifecycle helper ----
  /**
   * Sets running, runs `body` (after a checkpoint, so pause/cancel before start
   * are honoured), records completed / failed / cancelled and flushes.
   * Rethrows the body's error.
   */
  async run<R>(body: (p: this) => Promise<R>): Promise<R> {
    try {
      this.setStatus("running", {
        executor: { host: os.hostname(), pid: process.pid, heartbeatAt: new Date().toISOString() },
      });
      await this.checkpoint();
      const result = await body(this);
      this.setStatus("completed", { result });
      await this.flush();
      return result;
    } catch (e: any) {
      if (e instanceof ProcessCancelledError) {
        this.setStatus("cancelled");
      } else {
        this.setStatus("failed", {
          error: { message: e?.message ?? String(e), stack: e?.stack },
        });
      }
      await this.flush();
      throw e;
    }
  }
}
