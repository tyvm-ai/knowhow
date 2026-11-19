/**
 * Manual live test: do compaction requests read the agent's prompt cache?
 *
 * Simulates an agent turn (tool_choice "auto"), then a compaction request on
 * the same prefix + a summary prompt. Compares tool_choice "none" (what
 * compaction used to send) vs "auto" (same as the agent loop). Anthropic
 * invalidates the *messages* cache when tool_choice changes, so "none" should
 * re-write the whole conversation while "auto" reads it.
 *
 * Run: npx tsx tests/manual/compression/compactionCacheHit.ts [model]
 */
import { GenericAnthropicClient } from "../../../src/clients/anthropic";
import { Message, Tool } from "../../../src/clients/types";

const model = process.argv[2] || "claude-haiku-5-5";

const tools: Tool[] = ["readFile", "finalAnswer"].map((name) => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
}));

const nonce = Date.now();
const big = (label: string) =>
  `${label} ${nonce}\n` +
  Array.from({ length: 500 }, (_, i) => `${label} line ${i}: value=${i * 7}`).join("\n");

const usage = (r: any) => {
  const u = r.usage || {};
  return `read=${u.cache_read_input_tokens ?? 0} write=${
    u.cache_creation_input_tokens ?? 0
  } fresh=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} $${r.usd_cost?.toFixed(5)}`;
};

async function run(choice: "none" | "auto") {
  const client = new GenericAnthropicClient();
  const messages: Message[] = [
    { role: "system", content: `You are an agent. Run ${choice}-${nonce}.` },
    { role: "user", content: big("task-context") },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: `toolu_${choice}1`, type: "function", function: { name: "readFile", arguments: '{"query":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: `toolu_${choice}1`, name: "readFile", content: big("file-a") } as Message,
  ];
  const base = { model, tools, long_ttl_cache: false, max_tokens: 300 } as any;

  const turn = await client.createChatCompletion({ ...base, messages, tool_choice: "auto" });
  console.log(`[${choice}] agent turn:      ${usage(turn)}`);

  const compact = await client.createChatCompletion({
    ...base,
    tool_choice: choice,
    messages: [
      ...messages,
      { role: "user", content: "CONTEXT COMPACTION. Summarize the conversation in 2 sentences. Reply with text only; do not call tools." },
    ],
  });
  const calledTool = compact.choices.some((c) => c.message.tool_calls?.length);
  console.log(`[${choice}] compaction call: ${usage(compact)} toolCalled=${calledTool}`);
  return compact.usage?.cache_read_input_tokens ?? 0;
}

async function main() {
  const none = await run("none");
  const auto = await run("auto");
  console.log(
    `\ntool_choice none read ${none} cached tokens; auto read ${auto}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
