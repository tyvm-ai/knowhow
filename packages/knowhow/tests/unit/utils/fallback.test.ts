import { withFallback, FallbackError, BackendTimeoutError } from "../../../src/utils/fallback";

describe("withFallback", () => {
  const clock = () => {
    let t = 1000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("returns the first backend's result", async () => {
    const f = withFallback<number, string>([
      { name: "a", run: async (n) => `a${n}` },
      { name: "b", run: async (n) => `b${n}` },
    ]);
    expect(await f.run(1)).toEqual({ result: "a1", backend: "a" });
  });

  it("falls back on failure, reports it, and puts the failed backend in cooldown", async () => {
    const c = clock();
    const a = jest.fn().mockRejectedValue(new Error("boom"));
    const onFallback = jest.fn();
    const f = withFallback<void, string>(
      [
        { name: "a", run: a },
        { name: "b", run: async () => "ok" },
      ],
      { now: c.now, cooldownMs: 100, onFallback }
    );
    expect((await f.run()).backend).toBe("b");
    expect(onFallback).toHaveBeenCalledWith("a", expect.any(Error));
    expect(f.status().a.downUntil).toBe(1100);

    await f.run();
    expect(a).toHaveBeenCalledTimes(1); // skipped while cooling down

    c.advance(101);
    await f.run();
    expect(a).toHaveBeenCalledTimes(2); // retried after cooldown
  });

  it("times out slow backends", async () => {
    const f = withFallback<void, string>(
      [
        { name: "slow", run: () => new Promise(() => undefined), timeoutMs: 10 },
        { name: "fast", run: async () => "ok" },
      ]
    );
    const out = await f.run();
    expect(out.backend).toBe("fast");
    expect(f.status().slow.downUntil).toBeGreaterThan(0);
  });

  it("uses opts.timeoutMs as the default and BackendTimeoutError as the cause", async () => {
    const f = withFallback<void, string>(
      [{ name: "slow", run: () => new Promise(() => undefined) }],
      { timeoutMs: 5 }
    );
    const err: any = await f.run().catch((e) => e);
    expect(err).toBeInstanceOf(FallbackError);
    expect(err.failures[0].error).toBeInstanceOf(BackendTimeoutError);
  });

  it("throws an aggregate error listing every failure when all fail", async () => {
    const f = withFallback<void, string>([
      { name: "a", run: async () => { throw new Error("A broke"); } },
      { name: "b", run: async () => { throw new Error("B broke"); } },
    ]);
    const err: any = await f.run().catch((e) => e);
    expect(err).toBeInstanceOf(FallbackError);
    expect(err.message).toContain("a: A broke");
    expect(err.message).toContain("b: B broke");
    expect(err.errors).toHaveLength(2);
  });

  it("skips unavailable backends without cooling them down", async () => {
    let up = false;
    const a = jest.fn(async () => "a");
    const f = withFallback<void, string>([
      { name: "a", run: a, available: () => up },
      { name: "b", run: async () => "b" },
    ]);
    expect((await f.run()).backend).toBe("b");
    expect(f.status().a.downUntil).toBe(0);
    up = true;
    expect((await f.run()).backend).toBe("a");
  });

  it("reset() clears cooldowns; per-backend cooldown overrides the default", async () => {
    const c = clock();
    let fail = true;
    const f = withFallback<void, string>(
      [
        { name: "a", run: async () => { if (fail) throw new Error("x"); return "a"; }, cooldownMs: 50 },
        { name: "b", run: async () => "b" },
      ],
      { now: c.now, cooldownMs: 10_000 }
    );
    await f.run();
    expect(f.status().a.downUntil).toBe(1050);
    fail = false;
    expect((await f.run()).backend).toBe("b");
    f.reset();
    expect((await f.run()).backend).toBe("a");
  });
});
