/**
 * Manual live test: preserved-thinking prefix check ("thinking block is bound
 * to a different conversation").
 *
 * Models with preserved thinking (Fable/Mythos 5.1+, Opus/Sonnet/Haiku 5.5)
 * bind each signed thinking block to everything sent before it, including
 * `system` and `tools`. Knowhow's lazy-tools mode changes `tools` mid-task
 * (enableTools), which used to fail the next request with a 400.
 *
 * Run: npx tsx tests/manual/clients/anthropic.thinkingBinding.ts [model]
 * Costs about $0.02 per run on claude-fable-5-2.
 */
import { GenericAnthropicClient } from "../../../src/clients/anthropic";
import { Message, Tool } from "../../../src/clients/types";

const model = process.argv[2] || "claude-fable-5-2";

const tool = (name: string, description: string): Tool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "input" } },
      required: ["query"],
    },
  },
});

async function main() {
  const client = new GenericAnthropicClient();
  const baseTools = [
    tool("listAvailableTools", "List the tools you can enable."),
    tool("enableTools", "Enable tools by name."),
  ];
  const messages: Message[] = [
    { role: "system", content: "You are a careful agent. Use tools." },
    {
      role: "user",
      content:
        "Work out 4817 * 2393 in your head, then call listAvailableTools with the result as the query first, then after it answers call readFile with query 'README.md'.",
    },
  ];

  // Turn 1: thinking + tool call under the original tools list.
  const r1 = await client.createChatCompletion({
    model,
    messages,
    tools: baseTools,
    reasoning_effort: "high",
    reasoning_summary: true,
    max_tokens: 2000,
  });
  const a1 = r1.choices[0].message as any;
  const hasThinking = !!a1._reasoning_details?.items?.length;
  console.log(
    `turn 1: tool=${a1.tool_calls?.[0]?.function?.name} thinking=${hasThinking} $${r1.usd_cost}`
  );
  if (!a1.tool_calls?.length) throw new Error("expected a tool call");
  messages.push(a1, {
    role: "tool",
    tool_call_id: a1.tool_calls[0].id,
    name: a1.tool_calls[0].function.name,
    content: "Enabled readFile.",
  } as Message);

  // Turn 2: the tools list changed (what enableTools does in lazy mode).
  const r2 = await client.createChatCompletion({
    model,
    messages,
    tools: [...baseTools, tool("readFile", "Read a file.")],
    reasoning_effort: "high",
    reasoning_summary: true,
    max_tokens: 2000,
  });
  const a2 = r2.choices[0].message as any;
  console.log(
    `turn 2 (tools changed): ${a2.tool_calls?.[0]?.function?.name ?? a2.content?.slice(0, 80)} $${r2.usd_cost}`
  );
  console.log("✅ no prefix-check error after a tools change");

  // Fallback: without drop_block (e.g. a proxy strips the beta header) the
  // client must retry once without the earlier thinking blocks.
  const noBinding = new GenericAnthropicClient();
  noBinding.applyThinkingBinding = (_m, thinking) => ({ thinking });
  const r3 = await noBinding.createChatCompletion({
    model,
    messages,
    tools: [...baseTools, tool("readFile", "Read a file.")],
    reasoning_effort: "high",
    reasoning_summary: true,
    max_tokens: 2000,
  });
  const a3 = r3.choices[0].message as any;
  console.log(
    `fallback (no beta header): ${a3.tool_calls?.[0]?.function?.name ?? a3.content?.slice(0, 80)} $${r3.usd_cost}`
  );
  console.log("✅ fallback retry without earlier thinking works");
}

main().catch((e) => {
  console.error("❌", e?.message ?? e);
  process.exit(1);
});
