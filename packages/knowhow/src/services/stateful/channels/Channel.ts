import type {
  BaseControl,
  InputItem,
  ProcessDocument,
  ProcessMeta,
} from "../types";
import { isTerminalStatus } from "../types";

export interface ChannelLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * What a channel may do to / learn from its process. Per-channel: the context
 * knows which channel it belongs to (so `deliver`/`applyControl` carry the
 * right `source`).
 */
export interface ChannelContext<S = any, C extends BaseControl = BaseControl, E = any> {
  meta: ProcessMeta;
  snapshot(): ProcessDocument<S, C>;
  /** input side: the ONLY way a channel changes the process's control. */
  applyControl(patch: Partial<C>): void;
  /**
   * input side: hand stream items (and the cursor after them) to `onInput`.
   * Resolves (never rejects) with the process version once `onInput` finished;
   * pass it to `persisted()` before trimming the medium. If `ctx.cursor()` did
   * not advance to `cursor`, the items were not consumed.
   */
  deliver(items: Array<Omit<InputItem, "source">>, cursor: unknown): Promise<number>;
  /** this channel's last *consumed* cursor, as recorded in state (undefined at first). */
  cursor(): unknown;
  /**
   * Resolves when `version` (or newer) was persisted by channel `channelId`.
   * Without an id: this channel itself if it is an output/duplex channel,
   * otherwise every durable output channel. Rejects if the channel is stopped
   * before it got there.
   */
  persisted(version: number, channelId?: string): Promise<void>;
  setLink(key: string, value: string): void;
  log: ChannelLogger;
}

export interface Channel<S = any, C extends BaseControl = BaseControl, E = any> {
  readonly id: string;
  readonly direction: "in" | "out" | "duplex";
  /** Output policy (out/duplex channels). */
  readonly policy?: OutputPolicy;

  start(ctx: ChannelContext<S, C, E>): Promise<void>;
  /**
   * out/duplex: receives the FULL current document plus the events accumulated
   * since this channel's last successful publish. Return when durable; the pump
   * then marks `doc.version` persisted for this channel. The first publish after
   * start is the full snapshot.
   */
  publish?(doc: ProcessDocument<S, C>, events: E[]): Promise<void>;
  flush?(): Promise<void>;
  stop(): Promise<void>;
}

export interface OutputPolicy {
  /** Minimum ms between the starts of two publishes (terminal docs bypass it). */
  minIntervalMs?: number;
  /** Retries for a failing publish. Defaults: attempts 3, backoffMs 100 (doubling). */
  retry?: { attempts: number; backoffMs: number };
  /** Counts toward `persisted(v)` without a channel id. Default true. */
  durable?: boolean;
}

const DEFAULT_RETRY = { attempts: 3, backoffMs: 100 };

interface Waiter {
  version: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * Per-output-channel queue.
 *  - one publish in flight at a time;
 *  - keeps only the NEWEST pending doc; events of coalesced updates are
 *    concatenated and handed over with the next publish (so versions can be
 *    skipped, events are never dropped);
 *  - optional throttle, bounded retry with backoff;
 *  - errors never escape: they are logged, and the channel simply keeps the
 *    newest doc for the next attempt (isolated from other channels);
 *  - terminal documents bypass the throttle and are always published;
 *  - tracks `persistedVersion` for `persisted()`.
 */
export class ChannelPump<S = any, C extends BaseControl = BaseControl, E = any> {
  persistedVersion = -1;
  private pending?: { doc: ProcessDocument<S, C>; events: E[] };
  private loopPromise?: Promise<void>;
  private lastPublishStart = 0;
  private waiters: Waiter[] = [];
  private stopped = false;
  private wake?: () => void;
  private bypassThrottle = false;
  /** last permanent failure (after retries), cleared on success */
  lastError?: Error;

  constructor(
    readonly channel: Channel<S, C, E>,
    private log: ChannelLogger
  ) {}

  get durable(): boolean {
    return this.channel.policy?.durable !== false;
  }

  enqueue(doc: ProcessDocument<S, C>, events: E[] = []) {
    if (this.stopped) return;
    this.parkedAfterFailure = false;
    this.pending = {
      doc,
      events: [...(this.pending?.events ?? []), ...events],
    };
    if (isTerminalStatus(doc.lifecycle.status)) {
      this.bypassThrottle = true;
      this.wake?.();
    }
    this.ensureLoop();
  }

  private ensureLoop() {
    if (this.loopPromise) return;
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = undefined;
      // something may have been queued between loop exit and here
      if (this.pending && !this.stopped && !this.parkedAfterFailure) {
        this.ensureLoop();
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      (t as any).unref?.();
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  private async loop(): Promise<void> {
    const policy = this.channel.policy ?? {};
    const retry = policy.retry ?? DEFAULT_RETRY;
    while (this.pending && !this.stopped) {
      const wait =
        (policy.minIntervalMs ?? 0) - (Date.now() - this.lastPublishStart);
      if (wait > 0 && !this.bypassThrottle) {
        await this.sleep(wait);
        continue; // newer docs may have arrived (or bypass requested)
      }
      const job = this.pending;
      this.pending = undefined;
      this.lastPublishStart = Date.now();
      let ok = false;
      for (let attempt = 1; attempt <= retry.attempts && !this.stopped; attempt++) {
        try {
          await this.channel.publish!(job.doc, job.events);
          ok = true;
          break;
        } catch (e: any) {
          this.lastError = e instanceof Error ? e : new Error(String(e));
          this.log.error(
            `channel_error: ${this.channel.id} publish v${job.doc.version} failed (attempt ${attempt}/${retry.attempts}): ${this.lastError.message}`
          );
          if (attempt < retry.attempts) {
            await this.sleep(retry.backoffMs * 2 ** (attempt - 1));
          }
        }
      }
      if (ok) {
        this.lastError = undefined;
        this.persistedVersion = Math.max(this.persistedVersion, job.doc.version);
        this.resolveWaiters();
      } else if (!this.stopped) {
        // keep events for the next publish; if nothing newer is queued, keep
        // the doc too but do not spin: wait for the next enqueue.
        this.pending = {
          doc: this.pending?.doc ?? job.doc,
          events: [...job.events, ...(this.pending?.events ?? [])],
        };
        this.bypassThrottle = false;
        this.parkedAfterFailure = !this.hasNewerSince(job.doc.version);
        if (this.parkedAfterFailure) return;
      }
      this.bypassThrottle = false;
    }
  }

  private parkedAfterFailure = false;
  private hasNewerSince(version: number): boolean {
    return !!this.pending && this.pending.doc.version > version;
  }

  /** Called by enqueue-less retry: forces another attempt of a parked job. */
  retryParked() {
    if (this.pending) this.ensureLoop();
  }

  private resolveWaiters() {
    const rest: Waiter[] = [];
    for (const w of this.waiters) {
      if (this.persistedVersion >= w.version) w.resolve();
      else rest.push(w);
    }
    this.waiters = rest;
  }

  waitPersisted(version: number): Promise<void> {
    if (this.persistedVersion >= version) return Promise.resolve();
    if (this.stopped) {
      return Promise.reject(new Error(`channel ${this.channel.id} stopped`));
    }
    return new Promise<void>((resolve, reject) =>
      this.waiters.push({ version, resolve, reject })
    );
  }

  /** Resolve when the queue is drained (or parked after a permanent failure). */
  async flush(): Promise<void> {
    this.bypassThrottle = true;
    this.wake?.();
    if (this.parkedAfterFailure && this.pending) {
      this.parkedAfterFailure = false;
      this.ensureLoop();
    }
    while (this.loopPromise) {
      await this.loopPromise;
    }
    this.bypassThrottle = false;
    await this.channel.flush?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    while (this.loopPromise) await this.loopPromise;
    for (const w of this.waiters) {
      w.reject(new Error(`channel ${this.channel.id} stopped`));
    }
    this.waiters = [];
  }
}

/**
 * The read/control side of a medium, used by `ProcessMirror`: read the document,
 * watch for new ones, and write ONLY control and inputs (never state).
 */
export interface DocSource<S = any, C extends BaseControl = BaseControl, E = any> {
  readDocument(): Promise<ProcessDocument<S, C> | undefined>;
  /** `events` are those accumulated since the previous callback when the medium carries them. */
  watchDocument(cb: (doc: ProcessDocument<S, C>, events: E[]) => void): () => void;
  writeControl(patch: Partial<C>): Promise<void>;
  appendInput(item: {
    id?: string;
    kind?: string;
    text?: string;
    payload?: unknown;
    from?: string;
  }): Promise<void>;
}
