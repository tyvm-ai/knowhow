import {
  GAZE_ERROR_RADIUS,
  GAZE_TIMEOUT,
  GazeClient,
  nearestSample,
  resolveGazeHubUrl,
} from "../src/gaze";

const sample = (over: Record<string, unknown> = {}) => ({ x: 10, y: 20, timestamp: Date.now(), phase: "live", ...over });

function fakeFetch(handler: (url: string, init?: any) => { ok?: boolean; json?: unknown } | Error) {
  const calls: Array<{ url: string; init?: any }> = [];
  const f = (async (url: string, init?: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, json: async () => r.json } as any;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("resolveGazeHubUrl", () => {
  it("defaults to the local hub", () => {
    expect(resolveGazeHubUrl({})).toBe("http://127.0.0.1:7465");
  });

  it("prefers KNOWHOW_EYE_HUB_URL over the deprecated aliases", () => {
    expect(resolveGazeHubUrl({ KNOWHOW_EYE_HUB_URL: "http://a:1/", KNOWHOW_EYE_URL: "http://b:2", KNOWHOW_GAZE_URL: "http://c:3/api/gaze" })).toBe("http://a:1");
  });

  it("falls back to KNOWHOW_EYE_URL, then KNOWHOW_GAZE_URL (endpoint suffix stripped)", () => {
    expect(resolveGazeHubUrl({ KNOWHOW_EYE_URL: "http://b:2/", KNOWHOW_GAZE_URL: "http://c:3/api/gaze" })).toBe("http://b:2");
    expect(resolveGazeHubUrl({ KNOWHOW_GAZE_URL: "http://c:3/api/gaze" })).toBe("http://c:3");
  });
});

describe("constants", () => {
  it("has ONE error radius and named timeout presets", () => {
    expect(GAZE_ERROR_RADIUS).toEqual({ x: 200, y: 260 });
    expect(GAZE_TIMEOUT).toEqual({ tick: 100, fast: 150, normal: 500, slow: 1500 });
    expect(new GazeClient().errorRadius()).toEqual({ x: 200, y: 260 });
  });

  it("errorRadius() returns a copy callers may mutate", () => {
    const r = new GazeClient().errorRadius();
    r.x = 1;
    expect(new GazeClient().errorRadius().x).toBe(200);
  });
});

describe("GazeClient", () => {
  it("current() returns the sample and uses the hub URL", async () => {
    const { f, calls } = fakeFetch(() => ({ json: sample() }));
    const gaze = new GazeClient({ hubUrl: "http://hub:9/", fetch: f });
    expect(await gaze.current({ timeoutMs: GAZE_TIMEOUT.fast })).toMatchObject({ x: 10, y: 20 });
    expect(calls[0].url).toBe("http://hub:9/api/gaze");
    expect(calls[0].init.signal).toBeDefined();
  });

  it("current() is null for network errors, bad status, non-finite and stale samples", async () => {
    expect(await new GazeClient({ fetch: fakeFetch(() => new Error("down")).f }).current()).toBeNull();
    expect(await new GazeClient({ fetch: fakeFetch(() => ({ ok: false })).f }).current()).toBeNull();
    expect(await new GazeClient({ fetch: fakeFetch(() => ({ json: { x: NaN, y: 1 } })).f }).current()).toBeNull();
    const stale = fakeFetch(() => ({ json: sample({ timestamp: Date.now() - 5000 }) })).f;
    expect(await new GazeClient({ fetch: stale }).current({ maxAgeMs: 2000 })).toBeNull();
    expect(await new GazeClient({ fetch: stale }).current()).not.toBeNull(); // no maxAge → accepted
  });

  it("history() and at() pick the sample nearest the time", async () => {
    const samples = [sample({ timestamp: 1000 }), sample({ timestamp: 2000, x: 99 }), sample({ timestamp: 3000 })];
    const { f, calls } = fakeFetch(() => ({ json: { samples } }));
    const gaze = new GazeClient({ fetch: f });
    expect(await gaze.history(500)).toHaveLength(3);
    expect(calls[0].url).toContain("/api/gaze/history?sinceMs=500");
    expect((await gaze.at(2100, { windowMs: 1500 }))?.x).toBe(99);
    expect(calls[1].url).toContain("sinceMs=600");
  });

  it("history()/at() are empty/null when the hub is down", async () => {
    const gaze = new GazeClient({ fetch: fakeFetch(() => new Error("down")).f });
    expect(await gaze.history(0)).toEqual([]);
    expect(await gaze.at(5)).toBeNull();
  });

  it("correct() and recenter() POST and never throw", async () => {
    const { f, calls } = fakeFetch(() => ({}));
    const gaze = new GazeClient({ hubUrl: "http://hub:9", fetch: f });
    await gaze.correct({ x: 1, y: 2 });
    await gaze.recenter();
    expect(calls[0]).toMatchObject({ url: "http://hub:9/api/correct", init: { method: "POST", body: JSON.stringify({ x: 1, y: 2 }) } });
    expect(calls[1]).toMatchObject({ url: "http://hub:9/api/gaze/recenter", init: { method: "POST" } });
    const broken = new GazeClient({ fetch: fakeFetch(() => new Error("down")).f });
    await expect(broken.correct({ x: 1, y: 2 })).resolves.toBeUndefined();
    await expect(broken.recenter()).resolves.toBeUndefined();
  });
});

describe("nearestSample", () => {
  it("returns undefined for no samples and the closest otherwise", () => {
    expect(nearestSample([], 5)).toBeUndefined();
    expect(nearestSample([{ timestamp: 1 }, { timestamp: 10 }], 8)).toEqual({ timestamp: 10 });
  });
});
