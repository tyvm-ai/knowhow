import { getModelInfo } from "../../src/clients/pricing/modelInfo";
import {
  GenericAnthropicClient,
  TOOL_CHANGES_BETA,
  THINKING_BINDING_BETA,
} from "../../src/clients/anthropic";
import {
  applyToolChanges,
  buildDeferredTools,
  canAppendToolChange,
  createToolChangeMessage,
  deriveToolBaseline,
  diffToolChanges,
  flattenToolChanges,
} from "../../src/clients/toolChanges";
import { Message, Tool } from "../../src/clients/types";

const tool = (name: string): Tool => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  },
});

const okResponse = {
  data: {
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  response: { status: 200, headers: {} },
  request_id: "req",
};

function mockClient(fail?: (n: number) => any) {
  const client = new GenericAnthropicClient("fake-key");
  const sent: any[] = [];
  const create = jest.fn((body: any, opts: any) => {
    sent.push({ body: JSON.parse(JSON.stringify(body)), opts });
    const err = fail?.(sent.length);
    return {
      withResponse: () => (err ? Promise.reject(err) : Promise.resolve(okResponse)),
    };
  });
  (client as any).client = { messages: { create } };
  return { client, sent, create };
}

const thread = (): Message[] => [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Do the thing." },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "t1",
        type: "function",
        function: { name: "enableTools", arguments: '{"patterns":["readFile"]}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "t1", name: "enableTools", content: "ok" },
  createToolChangeMessage({ add: ["readFile"] }),
];

describe("toolChanges helpers", () => {
  it("replays markers onto a baseline and diffs against the enabled set", () => {
    const msgs = [
      createToolChangeMessage({ add: ["a", "b"] }),
      createToolChangeMessage({ remove: ["a"] }),
    ];
    const offered = applyToolChanges(["base"], msgs);
    expect([...offered].sort()).toEqual(["b", "base"]);
    expect(diffToolChanges(offered, ["base", "b"])).toBeUndefined();
    expect(diffToolChanges(offered, ["base", "c"])).toEqual({
      add: ["c"],
      remove: ["b"],
    });
  });

  it("derives the baseline of a resumed thread by undoing markers", () => {
    const msgs = [createToolChangeMessage({ add: ["x"], remove: ["y"] })];
    expect([...deriveToolBaseline(["base", "x"], msgs)].sort()).toEqual([
      "base",
      "y",
    ]);
  });

  it("only appends after a user/tool turn", () => {
    expect(canAppendToolChange([{ role: "user", content: "hi" }])).toBe(true);
    expect(canAppendToolChange([{ role: "assistant", content: "hi" }])).toBe(
      false
    );
    expect(canAppendToolChange([])).toBe(false);
  });

  it("marks non-baseline tools deferred and flattens back", () => {
    const tools = buildDeferredTools(
      [tool("finalAnswer"), tool("readFile"), tool("writeFile")],
      new Set(["finalAnswer"])
    );
    expect(tools.map((t) => !!t.defer_loading)).toEqual([false, true, true]);

    const flat = flattenToolChanges({
      model: "m",
      tools,
      messages: thread(),
    });
    expect(flat.tools!.map((t) => t.function.name)).toEqual([
      "finalAnswer",
      "readFile",
    ]);
    expect(flat.tools!.some((t) => t.defer_loading)).toBe(false);
    expect(flat.messages.some((m) => m._tool_changes)).toBe(false);
  });
});

describe("Anthropic mid-conversation tool changes", () => {
  const deferred = () =>
    buildDeferredTools(
      [tool("finalAnswer"), tool("enableTools"), tool("readFile")],
      new Set(["finalAnswer", "enableTools"])
    );

  it("reports support per model via the catalog's model info", () => {
    const supports = (model: string) =>
      !!getModelInfo(model, "anthropic").info.toolAdditions;
    expect(supports("claude-fable-5-2")).toBe(true);
    expect(supports("claude-opus-4-8")).toBe(true);
    expect(supports("claude-sonnet-5")).toBe(false);
    expect(supports("claude-sonnet-4-6")).toBe(false);
    // The knowhow proxy forwards cache settings but not tool additions.
    expect(getModelInfo("claude-fable-5-2", "knowhow").info.toolAdditions).toBe(false);
  });

  it("sends deferred tools, tool_addition blocks and the beta header", async () => {
    const { client, sent } = mockClient();
    await client.createChatCompletion({
      model: "claude-fable-5-2",
      messages: thread(),
      tools: deferred(),
      reasoning_effort: "high",
    });
    const { body, opts } = sent[0];

    expect(body.tools.map((t: any) => !!t.defer_loading)).toEqual([
      false,
      false,
      true,
    ]);
    // cache_control can't sit on a deferred definition.
    expect(body.tools[1].cache_control).toBeDefined();
    expect(body.tools[2].cache_control).toBeUndefined();
    // The marker must not leak into the top-level system prompt.
    expect(body.system[0].text).toBe("You are helpful.");
    expect(body.messages.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "system",
    ]);
    expect(body.messages[3].content).toEqual([
      {
        type: "tool_addition",
        tool: { type: "tool_reference", name: "readFile" },
      },
    ]);
    expect(opts.headers["anthropic-beta"].split(",").sort()).toEqual(
      [THINKING_BINDING_BETA, TOOL_CHANGES_BETA].sort()
    );
  });

  it("drops references to undeclared tools", async () => {
    const { client, sent } = mockClient();
    const messages = [
      ...thread().slice(0, 4),
      createToolChangeMessage({ add: ["ghost"] }),
    ];
    await client.createChatCompletion({
      model: "claude-fable-5-2",
      messages,
      tools: deferred(),
    });
    expect(sent[0].body.messages.some((m: any) => m.role === "system")).toBe(
      false
    );
  });

  it("flattens for models without tool-change support", async () => {
    const { client, sent } = mockClient();
    await client.createChatCompletion({
      model: "claude-sonnet-4-6",
      messages: thread(),
      tools: deferred(),
    });
    const { body, opts } = sent[0];
    expect(body.tools.map((t: any) => t.name)).toEqual([
      "finalAnswer",
      "enableTools",
      "readFile",
    ]);
    expect(body.tools.some((t: any) => t.defer_loading)).toBe(false);
    expect(body.messages.some((m: any) => m.role === "system")).toBe(false);
    expect(opts.headers).toBeUndefined();
  });

  it("retries in the classic shape when the API rejects tool changes", async () => {
    const err = Object.assign(new Error("400"), {
      status: 400,
      error: { error: { message: "tool_addition blocks are not supported" } },
    });
    const { client, sent } = mockClient((n) => (n === 1 ? err : undefined));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await client.createChatCompletion({
      model: "claude-fable-5-2",
      messages: thread(),
      tools: deferred(),
    });
    expect(res.choices[0].message.content).toBe("done");
    expect(sent).toHaveLength(2);
    expect(sent[1].body.tools.some((t: any) => t.defer_loading)).toBe(false);
    expect(
      sent[1].body.messages.some((m: any) => m.role === "system")
    ).toBe(false);
  });
});


describe("OpenAI Responses additional_tools", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GenericOpenAiClient } = require("../../src/clients/openai");

  function mockOpenAi() {
    const client = new GenericOpenAiClient("fake-key");
    const sent: any[] = [];
    const create = jest.fn((body: any) => {
      sent.push(JSON.parse(JSON.stringify(body)));
      return {
        withResponse: () =>
          Promise.resolve({
            data: {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "done" }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            response: { status: 200, headers: {} },
            request_id: "req",
          }),
      };
    });
    (client as any).client = { responses: { create } };
    return { client, sent };
  }

  const tools = () =>
    buildDeferredTools(
      [tool("enableTools"), tool("readFile")],
      new Set(["enableTools"])
    );

  it("supports Responses-only models, not Chat Completions ones", () => {
    const supports = (model: string) =>
      !!getModelInfo(model, "openai").info.toolAdditions;
    expect(supports("gpt-5.4")).toBe(true);
    expect(supports("gpt-4o")).toBe(false);
  });

  it("keeps deferred tools out of `tools` and inlines them where enabled", async () => {
    const { client, sent } = mockOpenAi();
    await client.createChatCompletion({
      model: "gpt-5.4",
      messages: thread(),
      tools: tools(),
    });
    const body = sent[0];
    expect(body.tools.map((t: any) => t.name)).toEqual(["enableTools"]);
    expect(body.instructions).toBe("You are helpful.");
    const last = body.input[body.input.length - 1];
    expect(last.type).toBe("additional_tools");
    expect(last.role).toBe("developer");
    expect(last.tools.map((t: any) => t.name)).toEqual(["readFile"]);
    expect(last.tools[0].defer_loading).toBeUndefined();
  });

  it("round-trips calls to inline-added tools with their namespace", async () => {
    const { client, sent } = mockOpenAi();
    const messages: Message[] = [
      ...thread(),
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "t2",
            type: "function",
            function: { name: "readFile", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "t2", name: "readFile", content: "x" },
    ];
    await client.createChatCompletion({ model: "gpt-5.4", messages, tools: tools() });
    const calls = sent[0].input.filter((i: any) => i.type === "function_call");
    expect(calls.map((c: any) => c.namespace)).toEqual([undefined, "readFile"]);
  });
});
