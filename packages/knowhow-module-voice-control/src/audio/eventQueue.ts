import { ContinuousClock } from "./types";

export const systemClock: ContinuousClock = { now: () => Date.now() };

export class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failed = false;
  private failure?: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failed = true;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failed) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function abortError(): Error {
  const error = new Error("Continuous transcript capture was aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
