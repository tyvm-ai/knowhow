import http, { _resetRateLimitState, parseRetryDelayMs } from "../../src/utils/http";

function res(status: number, body: any, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

describe("http rate-limit handling", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    _resetRateLimitState();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryDelayMs("3")).toBe(3000);
    expect(parseRetryDelayMs(null)).toBeUndefined();
    const d = parseRetryDelayMs(new Date(Date.now() + 10_000).toUTCString())!;
    expect(d).toBeGreaterThan(8000);
  });

  it("retries a 429 after Retry-After and succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(res(429, { error: { message: "slow" } }, { "Retry-After": "2" }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    global.fetch = fetchMock as any;

    const p = http.post("https://api.test/x", { a: 1 });
    await jest.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(600);
    const r = await p;
    expect(r.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the max retries", async () => {
    const fetchMock = jest
      .fn()
      .mockImplementation(async () => res(429, "no", { "Retry-After": "1" }));
    global.fetch = fetchMock as any;
    const p = http.get("https://api.test/y").catch((e) => e);
    await jest.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(err.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("paces requests when RateLimit-Remaining is nearly exhausted", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        res(200, {}, { "RateLimit-Remaining": "1", "RateLimit-Reset": "5" })
      )
      .mockResolvedValueOnce(res(200, {}));
    global.fetch = fetchMock as any;
    await http.get("https://api.test/a");
    const p = http.get("https://api.test/b");
    await jest.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1500);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
