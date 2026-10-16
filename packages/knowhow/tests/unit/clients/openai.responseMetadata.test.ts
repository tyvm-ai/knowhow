import { GenericOpenAiClient } from "../../../src/clients/openai";

const completionOptions = {
  model: "gpt-4o-mini",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("OpenAI response metadata", () => {
  it("emits native chat response metadata before mapping", async () => {
    const client = new GenericOpenAiClient("test-key");
    const observer = jest.fn();
    (client as any).client = {
      chat: {
        completions: {
          create: jest.fn(() => ({
            withResponse: async () => ({
              data: {
                choices: [{ message: { role: "assistant", content: "hi" } }],
                usage: undefined,
              },
              response: new Response(null, {
                status: 200,
                headers: {
                  "x-request-id": "chat-request",
                  "x-ratelimit-limit-requests": "100",
                  "x-ratelimit-remaining-requests": "99",
                  "x-ratelimit-limit-tokens": "1000",
                },
              }),
              request_id: "chat-request",
            }),
          })),
        },
      },
    };

    const result = await client.createChatCompletion({
      ...completionOptions,
      onResponseMetadata: observer,
    });
    expect(result.choices[0].message.content).toBe("hi");
    expect(observer).toHaveBeenCalledWith({
      statusCode: 200,
      requestId: "chat-request",
      rateLimit: { limit: 100, remaining: 99, tokenLimit: 1000 },
      headers: {
        "x-request-id": "chat-request",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "99",
        "x-ratelimit-limit-tokens": "1000",
      },
    });
  });

  it("emits API error metadata and preserves the original error", async () => {
    const client = new GenericOpenAiClient("test-key");
    const observer = jest.fn(() => {
      throw new Error("observer");
    });
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "2", authorization: "secret" },
      request_id: "rate-request",
    });
    (client as any).client = {
      chat: {
        completions: {
          create: jest.fn(() => ({
            withResponse: async () => {
              throw error;
            },
          })),
        },
      },
    };

    await expect(
      client.createChatCompletion({
        ...completionOptions,
        onResponseMetadata: observer,
      })
    ).rejects.toBe(error);
    expect(observer).toHaveBeenCalledWith({
      statusCode: 429,
      requestId: "rate-request",
      rateLimit: { retryAfterSeconds: 2 },
      headers: { "retry-after": "2" },
    });
  });
});
