/**
 * Shared retry/timeout helper for all AI clients.
 *
 * Executes `fn` with exponential backoff for retriable errors:
 * - Rate limits (429)
 * - Timeouts (AbortError, ETIMEDOUT, ECONNRESET)
 * - Server errors (5xx)
 *
 * @param fn          Function to execute. Receives an optional AbortSignal for timeout.
 * @param opts.timeout     Per-attempt timeout in ms. No timeout if omitted.
 * @param opts.maxRetries  Max retry attempts after first failure. Default: 2.
 * @param opts.backoffMs   Base backoff delay in ms for exponential backoff. Default: 1000.
 */
export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  opts: { timeout?: number; maxRetries?: number; backoffMs?: number } = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const backoffMs = opts.backoffMs ?? 1000;
  const timeout = opts.timeout;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = timeout ? new AbortController() : undefined;
    if (timeout && controller) {
      timer = setTimeout(() => controller.abort(), timeout);
    }
    try {
      const result = await fn(controller?.signal);
      return result;
    } catch (err: unknown) {
      clearTimeout(timer);
      const errStr = String(err);
      const isRetriable =
        errStr.includes('429') ||
        errStr.includes('timeout') ||
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
