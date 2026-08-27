const post = jest.fn();

jest.mock("../../../src/utils/http", () => ({
  __esModule: true,
  default: { post },
  HTTP_UNAUTHORIZED_HANDLER: Symbol("refresh"),
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      public response: Response,
      message: string
    ) {
      super(message);
    }
  },
}));

import { HttpClient } from "../../../src/clients/http";

describe("HttpClient response metadata", () => {
  beforeEach(() => post.mockReset());

  it("emits chat metadata and excludes transport-only options from its body", async () => {
    post.mockResolvedValue({
      status: 200,
      headers: new Headers({
        "x-request-id": "http-request",
        "x-ratelimit-limit-requests": "20",
        "x-ratelimit-remaining-requests": "19",
      }),
      data: {
        choices: [{ message: { role: "assistant", content: "hi" } }],
        model: "test",
      },
    });
    const observer = jest.fn();
    const client = new HttpClient("https://provider.example");
    const controller = new AbortController();
    await client.createChatCompletion({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
      timeout: 1,
      maxRetries: 0,
      backoffMs: 1,
      onResponseMetadata: observer,
    });

    expect(post.mock.calls[0][1]).not.toHaveProperty("onResponseMetadata");
    expect(post.mock.calls[0][1]).not.toHaveProperty("signal");
    expect(post.mock.calls[0][1]).not.toHaveProperty("timeout");
    expect(observer).toHaveBeenCalledWith({
      statusCode: 200,
      requestId: "http-request",
      rateLimit: { limit: 20, remaining: 19 },
      headers: {
        "x-request-id": "http-request",
        "x-ratelimit-limit-requests": "20",
        "x-ratelimit-remaining-requests": "19",
      },
    });
  });

  it("emits embedding error metadata and preserves the original HttpError", async () => {
    const { HttpError } = require("../../../src/utils/http");
    const error = new HttpError(
      429,
      new Response(null, { headers: { "retry-after": "3" } }),
      "rate limited"
    );
    post.mockRejectedValue(error);
    const observer = jest.fn();
    await expect(
      new HttpClient("https://provider.example").createEmbedding({
        model: "test",
        input: "hello",
        onResponseMetadata: observer,
      })
    ).rejects.toBe(error);
    expect(observer).toHaveBeenCalledWith({
      statusCode: 429,
      rateLimit: { retryAfterSeconds: 3 },
      headers: { "retry-after": "3" },
    });
  });
});
