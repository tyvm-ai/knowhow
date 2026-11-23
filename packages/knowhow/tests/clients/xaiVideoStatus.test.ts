import { GenericXAIClient } from "../../src/clients/xai";

describe("GenericXAIClient.getVideoStatus", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function respond(status: number, body: unknown) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    });
  }

  const client = new GenericXAIClient("test-key");

  it("returns failed (with code, message and billed cost) for a content-moderated 400", async () => {
    respond(400, {
      code: "imagine:content-moderated",
      error: "Generated video rejected by content moderation.",
      usage: { cost_in_usd_ticks: 6500000000 },
    });

    const res = await client.getVideoStatus({ jobId: "job-1" });

    expect(res.status).toBe("failed");
    expect(res.code).toBe("imagine:content-moderated");
    expect(res.error).toBe("Generated video rejected by content moderation.");
    // 1 USD = 1e10 ticks → 6.5e9 ticks = $0.65
    expect(res.usd_cost).toBeCloseTo(0.65, 10);
  });

  it("treats 404 as expired / not found", async () => {
    respond(404, "not found");
    const res = await client.getVideoStatus({ jobId: "gone" });
    expect(res.status).toBe("expired");
    expect(res.code).toBe("not_found");
    expect(res.error).toMatch(/not found/i);
    expect(res.usd_cost).toBeUndefined();
  });

  it("keeps throwing for 5xx errors (retryable)", async () => {
    respond(503, { error: "upstream unavailable" });
    await expect(client.getVideoStatus({ jobId: "job-2" })).rejects.toThrow(/503/);
  });

  it("keeps throwing for 429 rate limits", async () => {
    respond(429, { error: "slow down" });
    await expect(client.getVideoStatus({ jobId: "job-3" })).rejects.toThrow(/429/);
  });

  it("maps a completed job with billed cost", async () => {
    respond(200, {
      status: "done",
      video: { url: "https://x/v.mp4" },
      usage: { cost_in_usd_ticks: 6400000000 },
    });
    const res = await client.getVideoStatus({ jobId: "job-4" });
    expect(res.status).toBe("completed");
    expect(res.data?.[0]?.url).toBe("https://x/v.mp4");
    expect(res.usd_cost).toBeCloseTo(0.64, 10);
  });
});
