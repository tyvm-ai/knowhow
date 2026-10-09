import { createHash } from "crypto";

/**
 * Helpers for append-style output channels. A channel diffs against what IT
 * last persisted (the pump coalesces, so versions can be skipped), never
 * against the previous in-memory version.
 */

export function hashJson(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

export interface PersistedView {
  length: number;
  lastHash?: string;
}

export type Delta<T> =
  | { kind: "noop" }
  | { kind: "append"; from: number; items: T[] }
  | { kind: "replace"; items: T[] };

/**
 * Prefix-append detection for arrays of JSON values.
 *
 * - shorter than persisted           -> replace (history compressed/edited)
 * - same length, last item differs   -> replace
 * - longer, item at persisted.length-1 differs from `lastHash` -> replace
 * - otherwise                        -> noop / append the tail
 *
 * Only the boundary item is hashed (O(1) per publish), so a rewrite of an
 * EARLIER item that leaves the boundary item intact is not detected. Callers
 * that rewrite history in place should `reset()` the cursor. When `lastHash` is
 * unknown only lengths are compared.
 */
export function appendDelta<T>(
  persisted: PersistedView,
  next: T[],
  hash: (v: unknown) => string = hashJson
): Delta<T> {
  const n = persisted.length;
  if (next.length < n) return { kind: "replace", items: next };
  if (n > 0 && persisted.lastHash !== undefined) {
    if (hash(next[n - 1]) !== persisted.lastHash) {
      return { kind: "replace", items: next };
    }
  }
  if (next.length === n) return { kind: "noop" };
  return { kind: "append", from: n, items: next.slice(n) };
}

export type ThreadStep<T> = { index: number } & Delta<T>;

/** Per-thread `{length, lastHash}` as acknowledged by the medium. */
export class ThreadCursor<T = unknown> {
  private views: PersistedView[] = [];

  constructor(private hash: (v: unknown) => string = hashJson) {}

  view(index: number): PersistedView {
    return this.views[index] ?? { length: 0 };
  }

  lastHash(index: number): string | undefined {
    return this.views[index]?.lastHash;
  }

  /** Steps needed to bring the medium in line with `threads` (noops omitted). */
  plan(threads: T[][]): Array<ThreadStep<T>> {
    const steps: Array<ThreadStep<T>> = [];
    threads.forEach((thread, index) => {
      const d = appendDelta(this.view(index), thread, this.hash);
      if (d.kind !== "noop") steps.push({ index, ...d });
    });
    // threads that disappeared
    for (let index = threads.length; index < this.views.length; index++) {
      if (this.views[index] && this.views[index].length > 0) {
        steps.push({ index, kind: "replace", items: [] });
      }
    }
    return steps;
  }

  ack(index: number, length: number, lastHash?: string): void {
    this.views[index] = { length, lastHash };
  }

  /** Acknowledge a planned step, computing the hash from the thread we sent. */
  ackStep(step: ThreadStep<T>, thread: T[]): void {
    if (step.kind === "noop") return;
    this.ack(
      step.index,
      thread.length,
      thread.length ? this.hash(thread[thread.length - 1]) : undefined
    );
  }

  /** Acknowledge from server-reported lengths (+ optional hashes). */
  ackFrom(r: { lengths?: number[]; lastHashes?: Array<string | undefined> }): void {
    (r.lengths ?? []).forEach((length, i) => this.ack(i, length, r.lastHashes?.[i]));
  }

  /** Forget one thread (or all), e.g. after a 409: next plan replaces. */
  reset(index?: number): void {
    if (index === undefined) this.views = [];
    else delete this.views[index];
  }
}
