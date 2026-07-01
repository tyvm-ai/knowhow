/**
 * Shared retry/timeout helper for all AI clients.
 *
 * Executes `fn` with exponential backoff for retriable errors:
 * - Rate limits (429)
 * - Timeouts (AbortError, ETIMEDOUT, ECONNRESET)
 * - Server errors (5xx)
 *
 * @param fn               Function to execute. Receives a combined AbortSignal
 *                         that fires on per-attempt timeout OR external signal abort.
 * @param opts             Any object with optional RetryOptions fields (timeout, maxRetries,
 *                         backoffMs, signal). Extra fields are ignored — so you can pass the
 *                         full options object from any AI method directly.
 *                         - timeout: Per-attempt timeout in ms. No timeout if omitted.
 *                         - maxRetries: Max retry attempts after first failure. Default: 2.
 *                         - backoffMs: Base backoff delay in ms. Default: 1000.
 *                         - signal: Optional external AbortSignal. When aborted, the current
 *                         attempt is cancelled and no further retries are made.
 */
import type { RetryOptions } from "./types";

export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const backoffMs = opts.backoffMs ?? 1000;
  const timeout = opts.timeout;
  const externalSignal = opts.signal;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // If the external signal is already aborted, bail out immediately.
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? new DOMException("Aborted", "AbortError");
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Combine per-attempt timeout with the external signal into one controller.
    const controller = timeout || externalSignal ? new AbortController() : undefined;

    if (controller) {
      if (timeout) {
        timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeout);
      }
      // Forward external signal abort into our combined controller.
      if (externalSignal) {
        const onExternalAbort = () => controller.abort(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason ?? new DOMException("Aborted", "AbortError"));
        } else {
          externalSignal.addEventListener("abort", onExternalAbort, { once: true });
          // Clean up the listener after the attempt resolves/rejects.
          controller.signal.addEventListener("abort", () =>
            externalSignal.removeEventListener("abort", onExternalAbort), { once: true }
          );
        }
      }
    }

    try {
      const result = await fn(controller?.signal);
      return result;
    } catch (err: unknown) {
      clearTimeout(timer);
      // If the external signal was aborted, don't retry — propagate immediately.
      if (externalSignal?.aborted) {
        throw err;
      }
      const errStr = String(err);
      const isRetriable =
        errStr.includes('429') ||
        errStr.includes('timeout') ||
        errStr.includes('TimeoutError') ||
        errStr.includes('ECONNRESET') ||
        errStr.includes('ETIMEDOUT') ||
        errStr.includes('AbortError') ||
        /5\d\d/.test(errStr);
      if (isRetriable && attempt < maxRetries) {
        const delay = backoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('withRetry: exhausted retries');
}
