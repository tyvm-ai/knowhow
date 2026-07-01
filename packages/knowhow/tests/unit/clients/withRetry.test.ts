/**
 * Unit tests for withRetry — retry, timeout, and AbortSignal behaviour.
 *
 * These tests are isolated from AIClient: they exercise the withRetry helper
 * directly using a mock async function.
 */
import { withRetry } from "../../../src/clients/withRetry";

describe("withRetry", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── Success path ────────────────────────────────────────────────────────

  describe("success path", () => {
    it("returns the result immediately when fn succeeds on the first attempt", async () => {
      const fn = jest.fn().mockResolvedValue({ answer: 42 });
      const result = await withRetry(fn, { maxRetries: 2 });
      expect(result).toEqual({ answer: 42 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("passes undefined signal to fn when no timeout or external signal is provided", async () => {
      let receivedSignal: AbortSignal | undefined = "not-called" as any;
      const fn = jest.fn().mockImplementation((signal: any) => {
        receivedSignal = signal;
        return Promise.resolve("ok");
      });
      await withRetry(fn, {});
      expect(receivedSignal).toBeUndefined();
    });

    it("passes a signal to fn when a timeout is provided", async () => {
      let receivedSignal: AbortSignal | undefined;
      const fn = jest.fn().mockImplementation((signal: any) => {
        receivedSignal = signal;
        return Promise.resolve("ok");
      });
      await withRetry(fn, { timeout: 5000 });
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal!.aborted).toBe(false);
    });
  });

  // ─── Retry path ──────────────────────────────────────────────────────────

  describe("retry on retriable errors", () => {
    it("retries on a 429 rate-limit error and eventually succeeds", async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockResolvedValueOnce({ answer: "retried" });

      const promise = withRetry(fn, { maxRetries: 2, backoffMs: 100 });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ answer: "retried" });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries on a 500 server error and eventually succeeds", async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("500 Internal Server Error"))
        .mockResolvedValueOnce({
          choices: [{ message: { role: "assistant", content: "hi" } }],
        });

      const promise = withRetry(fn, { maxRetries: 2, backoffMs: 100 });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toMatchObject({
        choices: [{ message: { content: "hi" } }],
      });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries on ECONNRESET and succeeds", async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce("success");

      const promise = withRetry(fn, { maxRetries: 2, backoffMs: 100 });
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries up to maxRetries times then throws", async () => {
      jest.useFakeTimers();
      const fn = jest.fn().mockImplementation(() =>
        Promise.reject(new Error("500 Server Error"))
      );

      const resultPromise = withRetry(fn, { maxRetries: 2, backoffMs: 10 });
      // Suppress unhandled rejection warning while timers run
      resultPromise.catch(() => {});
      await jest.runAllTimersAsync();
      await expect(resultPromise).rejects.toThrow("500 Server Error");
      // 1 initial attempt + 2 retries = 3 total calls
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does NOT retry on a non-retriable error (e.g. 400 Bad Request)", async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new Error("400 Bad Request"));
      await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow(
        "400 Bad Request"
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry when maxRetries is 0", async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new Error("500 Server Error"));
      await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow(
        "500 Server Error"
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("uses exponential backoff between retries", async () => {
      jest.useFakeTimers();

      const error = new Error("500 err");
      const fn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("done");

      // Spy on setTimeout to capture backoff delay values
      const observedDelays: number[] = [];
      const origSetTimeout = global.setTimeout;
      const spy = jest
        .spyOn(global, "setTimeout")
        .mockImplementation((cb: any, delay?: number, ...args: any[]) => {
          if (delay === 100 || delay === 200) {
            observedDelays.push(delay!);
          }
          // Always run immediately so the test doesn't stall
          return origSetTimeout(cb, 0, ...args);
        });

      const promise = withRetry(fn, { maxRetries: 2, backoffMs: 100 });
      await jest.runAllTimersAsync();
      await promise;

      spy.mockRestore();

      // Attempt 0 backoff = 100 * 2^0 = 100ms; attempt 1 backoff = 100 * 2^1 = 200ms
      expect(observedDelays).toContain(100);
      expect(observedDelays).toContain(200);
    });
  });

  // ─── Timeout path ────────────────────────────────────────────────────────

  describe("per-attempt timeout", () => {
    it("aborts fn via signal when timeout fires and retries on the next attempt", async () => {
      jest.useFakeTimers();

      // First call: honours the signal abort (simulates slow network)
      // Second call: resolves immediately
      const fn = jest
        .fn()
        .mockImplementationOnce((signal: AbortSignal) => {
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        })
        .mockResolvedValueOnce("completed after timeout retry");

      const promise = withRetry(fn, {
        timeout: 1000,
        maxRetries: 2,
        backoffMs: 10,
      });

      // Advance timers: fires the timeout on the first attempt, then the backoff
      await jest.runAllTimersAsync();

      const result = await promise;
      expect(result).toBe("completed after timeout retry");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("throws after all retries are exhausted by timeouts", async () => {
      jest.useFakeTimers();

      // Every call hangs waiting for the abort signal
      const fn = jest.fn().mockImplementation((signal: AbortSignal) => {
        return new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const promise = withRetry(fn, {
        timeout: 500,
        maxRetries: 1,
        backoffMs: 10,
      });
      // Suppress unhandled rejection while timers run
      promise.catch(() => {});
      await jest.runAllTimersAsync();

      await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
      // 1 initial + 1 retry, both timed out
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ─── AbortSignal (external cancel) ───────────────────────────────────────

  describe("external AbortSignal", () => {
    it("does not call fn when signal is already aborted before invocation", async () => {
      const controller = new AbortController();
      controller.abort();

      const fn = jest.fn().mockResolvedValue("should not reach");
      await expect(
        withRetry(fn, { signal: controller.signal, maxRetries: 2 })
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(fn).not.toHaveBeenCalled();
    });

    it("cancels an in-flight request when signal is aborted externally", async () => {
      const controller = new AbortController();

      const fn = jest.fn().mockImplementation((signal: AbortSignal) => {
        return new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const promise = withRetry(fn, {
        signal: controller.signal,
        maxRetries: 2,
      });

      // Abort from outside while in-flight
      setImmediate(() =>
        controller.abort(new DOMException("User cancelled", "AbortError"))
      );

      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      // Must NOT retry after external abort
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does not retry after external abort even if error string looks retriable", async () => {
      const controller = new AbortController();
      controller.abort(new DOMException("Aborted", "AbortError"));

      const fn = jest.fn().mockResolvedValue("ok");
      await expect(
        withRetry(fn, { signal: controller.signal, maxRetries: 3 })
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(fn).not.toHaveBeenCalled();
    });

    it("forwards the combined signal to fn and it is not aborted on success", async () => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;

      const fn = jest.fn().mockImplementation((signal: AbortSignal) => {
        receivedSignal = signal;
        return Promise.resolve("ok");
      });

      await withRetry(fn, { signal: controller.signal, timeout: 5000 });

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal!.aborted).toBe(false);
    });
  });

  // ─── Combined timeout + external signal ──────────────────────────────────

  describe("timeout + external signal combined", () => {
    it("abort via external signal takes priority over pending timeout", async () => {
      const controller = new AbortController();

      const fn = jest.fn().mockImplementation((signal: AbortSignal) => {
        return new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      });

      const promise = withRetry(fn, {
        signal: controller.signal,
        timeout: 10_000, // long timeout — won't fire before external abort
        maxRetries: 2,
      });

      // Abort externally right away
      setImmediate(() =>
        controller.abort(new DOMException("User cancelled", "AbortError"))
      );

      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      // No retry after external abort
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
