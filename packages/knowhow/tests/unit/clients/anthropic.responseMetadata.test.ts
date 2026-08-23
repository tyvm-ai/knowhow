import { GenericAnthropicClient } from "../../../src/clients/anthropic";

const options = {
  model: "claude-sonnet-4-5",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("Anthropic response metadata", () => {
  it("emits native message response metadata", async () => {
    const client = new GenericAnthropicClient("test-key");
    const observer = jest.fn();
    (client as any).client = {
      messages: {
        create: jest.fn(() => ({
          withResponse: async () => ({
            data: {
              content: [{ type: "text", text: "hi" }],
              usage: { input_tokens: 3, output_tokens: 2 },
            },
            response: new Response(null, {
              status: 200,
              headers: {
                "request-id": "anthropic-request",
                "anthropic-ratelimit-requests-limit": "50",
                "anthropic-ratelimit-requests-remaining": "49",
                "anthropic-ratelimit-tokens-remaining": "900",
              },
            }),
            request_id: "anthropic-request",
          }),
        })),
      },
    };

    const result = await client.createChatCompletion({
      ...options,
      onResponseMetadata: observer,
    });
    expect(result.choices[0].message.content).toBe("hi");
    expect(observer).toHaveBeenCalledWith({
      statusCode: 200,
      requestId: "anthropic-request",
      rateLimit: { limit: 50, remaining: 49, tokenRemaining: 900 },
      headers: {
        "request-id": "anthropic-request",
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-requests-remaining": "49",
        "anthropic-ratelimit-tokens-remaining": "900",
      },
    });
  });

  it("emits API error metadata and preserves error identity", async () => {
    const client = new GenericAnthropicClient("test-key");
    const observer = jest.fn();
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "1", cookie: "private" },
      request_id: "anthropic-rate-request",
    });
    (client as any).client = {
      messages: {
        create: jest.fn(() => ({
          withResponse: async () => {
            throw error;
          },
        })),
      },
    };

    await expect(
      client.createChatCompletion({ ...options, onResponseMetadata: observer })
    ).rejects.toBe(error);
    expect(observer).toHaveBeenCalledWith({
      statusCode: 429,
      requestId: "anthropic-rate-request",
      rateLimit: { retryAfterSeconds: 1 },
      headers: { "retry-after": "1" },
    });
  });
});
