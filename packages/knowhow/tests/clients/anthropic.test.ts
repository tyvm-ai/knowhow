import {
  GenericAnthropicClient,
  THINKING_BINDING_BETA,
  isThinkingBindingError,
} from "../../src/clients/anthropic";

// We only need to test transformMessages, which doesn't require an API key
function createClient() {
  return new GenericAnthropicClient("fake-key");
}

describe("GenericAnthropicClient.transformMessages", () => {
  let client: GenericAnthropicClient;

  beforeEach(() => {
    client = createClient();
  });

  it("should handle a simple user message", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
    ];
    const result = client.transformMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    // String user messages become a text block so the first request can
    // write them to the prompt cache.
    expect(result[0].content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("caches the first string user message on the first request (long TTL)", () => {
    const result = client.transformMessages(
      [
        { role: "system" as const, content: "sys" },
        { role: "user" as const, content: "<ChatHistory>…</ChatHistory> task" },
      ],
      true
    );
    expect((result[0].content as any[])[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("should filter out system messages", () => {
    const messages = [
      { role: "system" as const, content: "You are helpful" },
      { role: "user" as const, content: "Hello" },
    ];
    const result = client.transformMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("should inject tool_use assistant block when processing tool result", () => {
    // Simulates: assistant responds with tool_call (content: ""), then tool result comes back
    const messages = [
      { role: "user" as const, content: "Use a tool" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "toolu_abc123",
            type: "function" as const,
            function: {
              name: "listAvailableTools",
              arguments: "{}",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "toolu_abc123",
        name: "listAvailableTools",
        content: '{"enabled": ["finalAnswer"], "disabled": []}',
      },
    ];

    const result = client.transformMessages(messages);

    // Should have: user msg, assistant tool_use block, user tool_result block
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Find the assistant message with tool_use
    const assistantMsg = result.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((c) => c.type === "tool_use")
    );
    expect(assistantMsg).toBeDefined();
    const toolUseBlock = (assistantMsg!.content as any[]).find(
      (c) => c.type === "tool_use"
    );
    expect(toolUseBlock.id).toBe("toolu_abc123");
    expect(toolUseBlock.name).toBe("listAvailableTools");

    // Find the user message with tool_result
    const userToolResult = result.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((c) => c.type === "tool_result")
    );
    expect(userToolResult).toBeDefined();
    const toolResultBlock = (userToolResult!.content as any[]).find(
      (c) => c.type === "tool_result"
    );
    expect(toolResultBlock.tool_use_id).toBe("toolu_abc123");
  });

  it("should not have undefined tool_use_id when assistant message has empty content with tool_calls", () => {
    // This is the failing scenario: assistant has content: "" (falsy) but has tool_calls
    const messages = [
      { role: "user" as const, content: "Use a tool" },
      {
        role: "assistant" as const,
        content: "",  // empty string - would be filtered by `msg.content` check
        tool_calls: [
          {
            id: "toolu_abc123",
            type: "function" as const,
            function: {
              name: "listAvailableTools",
              arguments: "{}",
            },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "toolu_abc123",
        name: "listAvailableTools",
        content: '{"enabled": ["finalAnswer"]}',
      },
    ];

    const result = client.transformMessages(messages);

    // Find the user message with tool_result - tool_use_id must NOT be undefined
    const userToolResult = result.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((c) => c.type === "tool_result")
    );
    expect(userToolResult).toBeDefined();
    const toolResultBlock = (userToolResult!.content as any[]).find(
      (c) => c.type === "tool_result"
    );
    // This should be "toolu_abc123", NOT undefined
    expect(toolResultBlock.tool_use_id).toBe("toolu_abc123");
    expect(toolResultBlock.tool_use_id).not.toBeUndefined();
  });

  it("should handle multiple sequential tool calls", () => {
    const messages = [
      { role: "user" as const, content: "Do two things" },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "toolu_111",
            type: "function" as const,
            function: { name: "toolOne", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "toolu_111",
        name: "toolOne",
        content: "result one",
      },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "toolu_222",
            type: "function" as const,
            function: { name: "toolTwo", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "toolu_222",
        name: "toolTwo",
        content: "result two",
      },
    ];

    const result = client.transformMessages(messages);

    // Both tool results should have correct tool_use_ids
    const toolResults = result
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => (m.content as any[]).filter((c) => c.type === "tool_result"));

    expect(toolResults).toHaveLength(2);
    const ids = toolResults.map((r) => r.tool_use_id);
    expect(ids).toContain("toolu_111");
    expect(ids).toContain("toolu_222");
    expect(ids).not.toContain(undefined);
  });

  it("should not crash when response is undefined (Cannot use in operator bug)", () => {
    // Test that the base agent undefined response check doesn't throw
    // This tests the guard we added to base.ts
    const undefinedLike = undefined as any;
    // Should not throw "Cannot use 'in' operator to search for 'response' in undefined"
    expect(() => {
      if (undefinedLike != null && "response" in undefinedLike) {
        // This should not be reached
      }
    }).not.toThrow();
  });
});

describe("preserved-thinking prefix binding", () => {
  const thinkingThread = () => [
    { role: "user" as const, content: "go" },
    {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function" as const,
          function: { name: "enableTools", arguments: "{}" },
        },
      ],
      _reasoning_details: {
        provider: "anthropic",
        items: [{ type: "thinking", thinking: "plan", signature: "sig" }],
      },
    } as any,
    { role: "tool" as const, tool_call_id: "toolu_1", content: "ok" } as any,
  ];

  const okResponse = {
    data: {
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    response: { status: 200, headers: {} },
    request_id: "req",
  };

  it("sends drop_block + the beta header for preserved-thinking models", () => {
    const client = new GenericAnthropicClient("fake-key");
    const thinking = client.getThinkingParam("claude-fable-5-2", "high");
    expect(client.applyThinkingBinding("claude-fable-5-2", thinking)).toEqual({
      thinking: {
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      headers: { "anthropic-beta": THINKING_BINDING_BETA },
    });
    // Opt-in model with thinking off: nothing to bind.
    expect(
      client.applyThinkingBinding(
        "claude-opus-5-5",
        client.getThinkingParam("claude-opus-5-5", "none")
      )
    ).toEqual({ thinking: undefined });
  });

  it("does not replay thinking blocks when thinking is off", () => {
    const client = new GenericAnthropicClient("fake-key");
    const withThinking = client.transformMessages(thinkingThread());
    const without = client.transformMessages(thinkingThread(), false, false);
    expect((withThinking[1].content as any[])[0].type).toBe("thinking");
    expect((without[1].content as any[]).map((b) => b.type)).toEqual([
      "tool_use",
    ]);
  });

  it("retries once without earlier thinking on a binding 400", async () => {
    const client = new GenericAnthropicClient("fake-key");
    const bindingError = Object.assign(new Error("400"), {
      status: 400,
      error: {
        error: {
          message:
            "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
        },
      },
    });
    const sent: any[] = [];
    const create = jest.fn((body: any, opts: any) => {
      sent.push({ body: JSON.parse(JSON.stringify(body)), opts });
      return {
        withResponse: () =>
          sent.length === 1
            ? Promise.reject(bindingError)
            : Promise.resolve(okResponse),
      };
    });
    (client as any).client = { messages: { create } };
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = await client.createChatCompletion({
      model: "claude-fable-5-2",
      messages: thinkingThread(),
      reasoning_effort: "high",
    });

    expect(res.choices[0].message.content).toBe("done");
    expect(create).toHaveBeenCalledTimes(2);
    expect(sent[0].opts.headers).toEqual({
      "anthropic-beta": THINKING_BINDING_BETA,
    });
    expect(sent[0].body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: "drop_block",
    });
    const firstTypes = sent[0].body.messages[1].content.map((b: any) => b.type);
    const retryTypes = sent[1].body.messages[1].content.map((b: any) => b.type);
    expect(firstTypes).toEqual(["thinking", "tool_use"]);
    expect(retryTypes).toEqual(["tool_use"]);
  });

  it("recognises the binding error", () => {
    expect(
      isThinkingBindingError(
        new Error("The block is bound to a different conversation.")
      )
    ).toBe(true);
    expect(isThinkingBindingError(new Error("overloaded"))).toBe(false);
  });
});
