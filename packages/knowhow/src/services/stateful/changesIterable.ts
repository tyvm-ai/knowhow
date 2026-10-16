import type { Unsubscribe } from "./types";

/**
 * Turn a subscribe function into an AsyncIterable. Buffers items; ends on
 * abort, or after the item that made `isDone()` true (immediately when already
 * done). Shared by StatefulProcess and ProcessMirror.
 */
export function changesIterable<T>(
  subscribe: (cb: (c: T) => void) => Unsubscribe,
  isDone: () => boolean,
  signal?: AbortSignal
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      let wake: (() => void) | undefined;
      let done = isDone() || !!signal?.aborted;
      let unsub: Unsubscribe = () => {};
      const finish = () => {
        done = true;
        unsub();
        signal?.removeEventListener("abort", finish);
        wake?.();
      };
      unsub = subscribe((c) => {
        queue.push(c);
        if (isDone()) done = true;
        wake?.();
      });
      signal?.addEventListener("abort", finish);
      if (done) finish();
      return {
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            if (queue.length) {
              const value = queue.shift()!;
              if (!queue.length && done) finish();
              return { value, done: false };
            }
            if (done) {
              finish();
              return { value: undefined as any, done: true };
            }
            await new Promise<void>((r) => (wake = r));
            wake = undefined;
          }
        },
        async return(): Promise<IteratorResult<T>> {
          finish();
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}
