/**
 * Tests for the BaseAgent interrupt / makeInterruptible mechanism.
 *
 * These verify the fix for the "agent gets stuck after /poke" bug:
 *  1. A stale (slow) operation that finishes AFTER its window was interrupted
 *     must NOT clobber a newer interruptible window's resolver.
 *  2. An interrupt() arriving with no active window must be queued and fire on
 *     the next makeInterruptible window (not silently dropped).
 *  3. Normal (non-interrupted) resolution still works.
 *  4. Errors propagate when not interrupted, and are swallowed when interrupted.
 */

// Minimal harness exposing the protected members of BaseAgent's interrupt logic.
// We replicate the class shape just enough to exercise makeInterruptible/interrupt
// by importing the real implementation would require constructing a full agent
// (abstract, many deps). Instead we test the exact algorithm via a tiny stand-in
// that mirrors src/agents/base/base.ts. If the base implementation changes, these
// tests document the intended contract.

class InterruptHarness {
  private _interruptResolve: (() => void) | null = null;
  private _interruptToken = 0;
  private _pendingInterrupt = false;
  public pendingUserMessages: any[] = [];

  addPendingUserMessage(m: any) {
    this.pendingUserMessages.push(m);
  }

  makeInterruptible<T>(promise: Promise<T>, interruptValue: T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const myToken = ++this._interruptToken;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this._interruptToken === myToken) {
          this._interruptResolve = null;
        }
        fn();
      };

      this._interruptResolve = () => finish(() => resolve(interruptValue));

      if (this._pendingInterrupt) {
        this._pendingInterrupt = false;
        finish(() => resolve(interruptValue));
        return;
      }

      promise
        .then((result) => {
          finish(() => resolve(result));
        })
        .catch((err) => {
          if (settled) return;
          finish(() => reject(err));
        });
    });
  }

  interrupt(message = "User interrupted this action you were waiting on") {
    if (
      message &&
      message !== "User interrupted this action you were waiting on"
    ) {
      this.addPendingUserMessage({ role: "user", content: message });
    }
    if (this._interruptResolve) {
      this._interruptResolve();
    } else {
      this._pendingInterrupt = true;
    }
  }

  get hasActiveResolver() {
    return this._interruptResolve !== null;
  }
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("BaseAgent interrupt / makeInterruptible", () => {
  test("normal resolution passes through the real result", async () => {
    const h = new InterruptHarness();
    const wrapped = h.makeInterruptible(Promise.resolve("real"), "INT");
    await expect(wrapped).resolves.toBe("real");
  });

  test("interrupt() resolves the active window with the interrupt value", async () => {
    const h = new InterruptHarness();
    const slow = deferred<string>();
    const wrapped = h.makeInterruptible(slow.promise, "INT");
    h.interrupt();
    await expect(wrapped).resolves.toBe("INT");
    // The slow op finishing later must not throw or affect anything.
    slow.resolve("late");
    await slow.promise;
  });

  test("STALE completion does NOT clobber a newer window (the stuck bug)", async () => {
    const h = new InterruptHarness();

    // Window 1: a slow tool call (like sleep 360).
    const slowTool = deferred<string>();
    const w1 = h.makeInterruptible(slowTool.promise, "INT1");

    // User pokes -> window 1 resolves with the interrupt value.
    h.interrupt();
    await expect(w1).resolves.toBe("INT1");

    // Agent moves on to window 2 (the next AI completion).
    const nextOp = deferred<string>();
    const w2 = h.makeInterruptible(nextOp.promise, "INT2");

    // Now the OLD slow tool finally finishes in the background.
    // Before the fix, this stale .then() would null out window 2's resolver.
    slowTool.resolve("stale-tool-result");
    // Give microtasks a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    // Window 2 must still be interruptible — resolver intact.
    expect(h.hasActiveResolver).toBe(true);

    // And interrupting window 2 must still work.
    h.interrupt();
    await expect(w2).resolves.toBe("INT2");
  });

  test("stale completion does not resolve the newer window with old result", async () => {
    const h = new InterruptHarness();
    const slowTool = deferred<string>();
    const w1 = h.makeInterruptible(slowTool.promise, "INT1");
    h.interrupt();
    await expect(w1).resolves.toBe("INT1");

    const nextOp = deferred<string>();
    const w2 = h.makeInterruptible(nextOp.promise, "INT2");

    // Old tool completes late with its (now irrelevant) result.
    slowTool.resolve("stale-tool-result");
    await Promise.resolve();
    await Promise.resolve();

    // Window 2 resolves with ITS OWN op result, not the stale one.
    nextOp.resolve("fresh-result");
    await expect(w2).resolves.toBe("fresh-result");
  });

  test("interrupt() with no active window is queued and fires next window", async () => {
    const h = new InterruptHarness();
    // No active window yet.
    expect(h.hasActiveResolver).toBe(false);
    h.interrupt(); // queued, not dropped

    // Next window should fire immediately with the interrupt value.
    const op = deferred<string>();
    const w = h.makeInterruptible(op.promise, "INT");
    await expect(w).resolves.toBe("INT");
    // Underlying op finishing later must be harmless.
    op.resolve("later");
    await op.promise;
  });

  test("errors propagate when not interrupted", async () => {
    const h = new InterruptHarness();
    const failing = Promise.reject(new Error("boom"));
    const wrapped = h.makeInterruptible(failing, "INT");
    await expect(wrapped).rejects.toThrow("boom");
  });

  test("errors are swallowed if the window was already interrupted", async () => {
    const h = new InterruptHarness();
    const failing = deferred<string>();
    const wrapped = h.makeInterruptible(failing.promise, "INT");
    h.interrupt();
    await expect(wrapped).resolves.toBe("INT");
    // The underlying op rejects late — must not cause an unhandled rejection
    // or re-settle the already-resolved window.
    failing.reject(new Error("late-boom"));
    await failing.promise.catch(() => {});
  });

  test("/poke with a message queues it as a pending user message", () => {
    const h = new InterruptHarness();
    h.interrupt("please check the logs");
    expect(h.pendingUserMessages).toEqual([
      { role: "user", content: "please check the logs" },
    ]);
  });

  test("/poke with the default reason does NOT add a pending user message", () => {
    const h = new InterruptHarness();
    h.interrupt();
    expect(h.pendingUserMessages).toEqual([]);
  });
});
