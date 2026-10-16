/**
 * `withFallback` — try backends in order, with a per-backend circuit breaker.
 *
 * A backend that throws (or times out) is put in cooldown and skipped until
 * `downUntil`; if every backend fails, a `FallbackError` listing each failure
 * is thrown. The clock is injectable for tests.
 */

export interface Backend<A, R> {
  name: string;
  run(args: A): Promise<R>;
  /** Per-backend timeout (overrides opts.timeoutMs). 0/undefined = none. */
  timeoutMs?: number;
  /** Per-backend cooldown after a failure (overrides opts.cooldownMs). */
  cooldownMs?: number;
  /** Return false to skip this backend without counting it as a failure. */
  available?(): boolean;
}

export interface WithFallbackOptions {
  timeoutMs?: number;
  /** Default 30_000 ms. */
  cooldownMs?: number;
  now?: () => number;
  onFallback?(from: string, err: unknown): void;
}

export interface FallbackFailure {
  backend: string;
  error: unknown;
  /** True when the backend was skipped (cooldown / unavailable) rather than run. */
  skipped?: boolean;
}

export class FallbackError extends Error {
  constructor(public readonly failures: FallbackFailure[]) {
    super(
      "all backends failed: " +
        (failures.length
          ? failures
              .map(
                (f) =>
                  `${f.backend}${f.skipped ? " (skipped)" : ""}: ${
                    f.error instanceof Error ? f.error.message : String(f.error)
                  }`
              )
              .join("; ")
          : "(no backends configured)")
    );
    this.name = "FallbackError";
    Object.setPrototypeOf(this, FallbackError.prototype);
  }
  /** AggregateError-compatible alias. */
  get errors(): unknown[] {
    return this.failures.map((f) => f.error);
  }
}

export class BackendTimeoutError extends Error {
  constructor(public readonly backend: string, public readonly timeoutMs: number) {
    super(`backend "${backend}" timed out after ${timeoutMs}ms`);
    this.name = "BackendTimeoutError";
    Object.setPrototypeOf(this, BackendTimeoutError.prototype);
  }
}

const DEFAULT_COOLDOWN_MS = 30_000;

export function withFallback<A, R>(
  backends: Backend<A, R>[],
  opts: WithFallbackOptions = {}
): {
  run(args: A): Promise<{ result: R; backend: string }>;
  reset(): void;
  status(): Record<string, { downUntil: number }>;
} {
  const now = opts.now ?? Date.now;
  const downUntil = new Map<string, number>();

  const callWithTimeout = (b: Backend<A, R>, args: A): Promise<R> => {
    const ms = b.timeoutMs ?? opts.timeoutMs;
    const p = Promise.resolve().then(() => b.run(args));
    if (!ms || ms <= 0) return p;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BackendTimeoutError(b.name, ms)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };

  return {
    async run(args: A) {
      const failures: FallbackFailure[] = [];
      for (const b of backends) {
        const until = downUntil.get(b.name) ?? 0;
        if (until > now()) {
          failures.push({
            backend: b.name,
            error: new Error(`in cooldown until ${until}`),
            skipped: true,
          });
          continue;
        }
        if (b.available && !b.available()) {
          failures.push({ backend: b.name, error: new Error("unavailable"), skipped: true });
          continue;
        }
        try {
          const result = await callWithTimeout(b, args);
          downUntil.delete(b.name);
          return { result, backend: b.name };
        } catch (err) {
          downUntil.set(b.name, now() + (b.cooldownMs ?? opts.cooldownMs ?? DEFAULT_COOLDOWN_MS));
          failures.push({ backend: b.name, error: err });
          opts.onFallback?.(b.name, err);
        }
      }
      throw new FallbackError(failures);
    },
    reset() {
      downUntil.clear();
    },
    status() {
      const out: Record<string, { downUntil: number }> = {};
      for (const b of backends) out[b.name] = { downUntil: downUntil.get(b.name) ?? 0 };
      return out;
    },
  };
}
