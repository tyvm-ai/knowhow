/**
 * Injectable clock. Everything in voice-control that polls, debounces or
 * expires (map watcher, hint mode, gaze follow, scroll, overlay clear, pointer
 * memory, pending actions) goes through `services.clock` so tests can drive
 * time with a fake clock and assert that a stopped session leaves no live
 * timers behind.
 */

/** What `setTimeout`/`setInterval` hand back; `unref` is optional (fake timers). */
export interface TimerHandle {
  unref?(): unknown;
  ref?(): unknown;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
  /** Resolve after `ms` (a fake clock advances itself instead of waiting). */
  sleep(ms: number): Promise<void>;
}

/**
 * The real clock. Globals are looked up at call time (not captured at import)
 * so jest's fake timers keep working with it.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => globalThis.clearTimeout(h as unknown as NodeJS.Timeout),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as TimerHandle,
  clearInterval: (h) => globalThis.clearInterval(h as unknown as NodeJS.Timeout),
  sleep: (ms) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
};
