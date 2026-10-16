import {
  emitResponseMetadata,
  normalizeRateLimitMetadata,
  normalizeResponseMetadata,
} from "../../../src/clients/responseMetadata";

describe("response metadata", () => {
  it("normalizes and allowlists safe headers and derives a request id", () => {
    const metadata = normalizeResponseMetadata({
      statusCode: 429,
      headers: {
        "X-RateLimit-Remaining": "0",
        "X-Request-Id": "request-123",
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "X-Private-Value": "never expose",
      },
    });

    expect(metadata).toEqual({
      statusCode: 429,
      requestId: "request-123",
      rateLimit: { remaining: 0 },
      headers: {
        "x-ratelimit-remaining": "0",
        "x-request-id": "request-123",
      },
    });
  });

  it("uses an explicit request id and retains only the first duplicate header", () => {
    const metadata = normalizeResponseMetadata({
      requestId: "explicit-id",
      headers: [
        ["Retry-After", "1"],
        ["retry-after", "2"],
        ["CF-Ray", "ray-id"],
      ],
    });

    expect(metadata.requestId).toBe("explicit-id");
    expect(metadata.headers).toEqual({
      "retry-after": "1",
      "cf-ray": "ray-id",
    });
  });

  it("normalizes standard and OpenAI-compatible limits into JSON-safe values", () => {
    const now = new Date("2026-08-23T00:00:00.000Z");
    expect(
      normalizeRateLimitMetadata(
        {
          "ratelimit-limit": "100",
          "ratelimit-remaining": "9",
          "ratelimit-reset": "60",
          "retry-after": "2",
          "x-ratelimit-limit-tokens": "2000",
          "x-ratelimit-remaining-tokens": "100",
          "x-ratelimit-reset-tokens": "1m30s",
        },
        now
      )
    ).toEqual({
      limit: 100,
      remaining: 9,
      resetAt: "2026-08-23T00:01:00.000Z",
      retryAfterSeconds: 2,
      tokenLimit: 2000,
      tokenRemaining: 100,
      tokenResetAt: "2026-08-23T00:01:30.000Z",
    });
  });

  it("normalizes Anthropic request and token windows", () => {
    expect(
      normalizeRateLimitMetadata(
        {
          "anthropic-ratelimit-requests-limit": "50",
          "anthropic-ratelimit-requests-remaining": "10",
          "anthropic-ratelimit-requests-reset": "2026-08-23T00:01:00Z",
          "anthropic-ratelimit-tokens-limit": "40000",
          "anthropic-ratelimit-tokens-remaining": "5000",
          "anthropic-ratelimit-tokens-reset": "2026-08-23T00:02:00Z",
        },
        new Date("2026-08-23T00:00:00Z")
      )
    ).toEqual({
      limit: 50,
      remaining: 10,
      resetAt: "2026-08-23T00:01:00.000Z",
      tokenLimit: 40000,
      tokenRemaining: 5000,
      tokenResetAt: "2026-08-23T00:02:00.000Z",
    });
  });

  it("bounds retained values and isolates observer failures", () => {
    const value = "x".repeat(300);
    const observer = jest.fn(() => {
      throw new Error("telemetry failure");
    });

    expect(() =>
      emitResponseMetadata(
        { onResponseMetadata: observer },
        { headers: { "x-ratelimit-reset": value } }
      )
    ).not.toThrow();
    expect(observer).toHaveBeenCalledWith({
      rateLimit: {},
      headers: { "x-ratelimit-reset": "x".repeat(256) },
    });
  });

  it("limits retained header count and aggregate data", () => {
    const headers: Record<string, string> = {};
    for (let index = 0; index < 30; index++)
      headers[`x-ratelimit-test-${index}`] = String(index);
    expect(
      Object.keys(normalizeResponseMetadata({ headers }).headers)
    ).toHaveLength(24);
  });
});
