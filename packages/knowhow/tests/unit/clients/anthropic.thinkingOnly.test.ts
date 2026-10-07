import { GenericAnthropicClient } from "../../../src/clients/anthropic";

const options = {
  model: "claude-opus-5-5",
  messages: [{ role: "user" as const, content: "hello" }],
};

function mockClient(responses: any[]) {
  const client = new GenericAnthropicClient("test-key");
  const create = jest.fn().mockImplementation(() => ({
    withResponse: async () => ({
      data: responses.shift(),
      response: new Response(null, { status: 200 }),
      request_id: "request-id",
    }),
  }));
  (client as any).client = { messages: { create } };
  return { client, create };
}

const thinking = { type: "thinking", thinking: "unfinished", signature: "signed" };

it("retries thinking-only max_tokens responses with more room and accounts for both calls", async () => {
  const { client, create } = mockClient([
    { content: [thinking], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 8000 } },
    { content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  const result = await client.createChatCompletion({ ...options, max_tokens: 8000 });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0].max_tokens).toBe(8000);
  expect(create.mock.calls[1][0].max_tokens).toBe(16000);
  expect(create.mock.calls[1][0].messages).toEqual(create.mock.calls[0][0].messages);
  expect(result.choices).toHaveLength(1);
  expect(result.choices[0].message.content).toBe("answer");
  expect(result.usage?.output_tokens).toBe(8005);
});

it("fails clearly after one retry instead of returning empty choices", async () => {
  const { client, create } = mockClient([
    { content: [thinking], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 8000 } },
    { content: [thinking], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 16000 } },
  ]);
  await expect(client.createChatCompletion(options)).rejects.toThrow(/no text or tool use.*max_tokens/);
  expect(create).toHaveBeenCalledTimes(2);
});

it("does not retry a thinking-only end_turn response", async () => {
  const { client, create } = mockClient([
    { content: [thinking], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  await expect(client.createChatCompletion(options)).rejects.toThrow(/no text or tool use/);
  expect(create).toHaveBeenCalledTimes(1);
});

it("round-trips signed thinking blocks on tool-use turns", async () => {
  const { client } = mockClient([
    { content: [thinking, { type: "tool_use", id: "call-1", name: "search", input: { q: "a" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  const result = await client.createChatCompletion(options);
  const messages = client.transformMessages([
    ...options.messages,
    result.choices[0].message,
    { role: "tool", tool_call_id: "call-1", content: "found" },
  ]);
  expect(messages[1].content).toEqual([thinking, { type: "tool_use", id: "call-1", name: "search", input: { q: "a" } }]);
});
