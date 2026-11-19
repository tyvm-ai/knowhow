/**
 * Manual live test: mid-conversation tool changes (defer_loading + tool_addition).
 *
 * The full tool catalog is declared on every request, with tools that aren't
 * enabled yet marked `defer_loading`. When the agent enables a tool, a
 * `_tool_changes` marker is appended to the thread instead of changing
 * `tools`, so the prefix stays byte-identical: the prompt cache keeps hitting
 * and earlier thinking blocks stay valid.
 *
 * Checks, per turn: no fallback retry happened, the deferred tool is callable
 * only after the marker, and turn 2+ reads the prefix from cache.
 *
 * Run: npx tsx tests/manual/clients/anthropic.toolChanges.ts [model]
 */
import { GenericAnthropicClient } from "../../../src/clients/anthropic";
import {
  buildDeferredTools,
  createToolChangeMessage,
} from "../../../src/clients/toolChanges";
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

// Large enough stable prefix to be cacheable on every model.
const filler = Array.from(
  { length: 400 },
  (_, i) => `Rule ${i}: keep answers short and use tools when asked.`
).join("\n");

async function main() {
  const client = new GenericAnthropicClient();
  let retried = false;
  const warn = console.warn;
  console.warn = (...args: any[]) => {
    if (String(args[0]).includes("retrying")) retried = true;
    warn(...args);
  };

  const catalog = [
    tool("enableTools", "Enable tools by name. Available: readFile."),
    tool("finalAnswer", "Give the final answer."),
    tool("readFile", "Read a file. Call with query=<path>."),
  ];
  const tools = buildDeferredTools(
    catalog,
    new Set(["enableTools", "finalAnswer"])
  );
  const messages: Message[] = [
    { role: "system", content: `You are a careful agent.\n${filler}` },
    {
      role: "user",
      content:
        "Read the file README.md. The readFile tool isn't enabled yet; enable it with enableTools first, then call readFile.",
    },
  ];

  const calls: string[] = [];
  let failures = 0;
  for (let turn = 1; turn <= 4; turn++) {
    retried = false;
    const res = await client.createChatCompletion({
      model,
      messages,
      tools,
      reasoning_effort: "low",
      max_tokens: 4000,
    });
    const msg = res.choices.find((c) => c.message.tool_calls?.length)?.message;
    const call = msg?.tool_calls?.[0];
    const u: any = res.usage;
    console.log(
      `turn ${turn}: tool=${call?.function.name ?? "-"} cache_read=${
        u?.cache_read_input_tokens
      } cache_write=${u?.cache_creation_input_tokens} input=${
        u?.input_tokens
      } $${res.usd_cost?.toFixed(5)} ${retried ? "(FELL BACK)" : ""}`
    );
    if (retried) failures++;
    if (turn > 1 && !(u?.cache_read_input_tokens > 0)) {
      console.log("  ❌ expected a cache read");
      failures++;
    }
    if (!call) break;
    calls.push(call.function.name);
    messages.push({ ...msg, tool_calls: [call] });
    const result =
      call.function.name === "readFile"
        ? "# README\nHello from the deferred tool."
        : call.function.name === "enableTools"
        ? "Enabled: readFile"
        : "ok";
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: result,
    });
    if (call.function.name === "enableTools") {
      messages.push(createToolChangeMessage({ add: ["readFile"] }));
    }
    if (call.function.name === "finalAnswer" || call.function.name === "readFile")
      break;
  }

  const enabledFirst =
    calls.indexOf("enableTools") >= 0 &&
    calls.indexOf("readFile") > calls.indexOf("enableTools");
  console.log(`calls: ${calls.join(" → ")}`);
  console.log(
    enabledFirst && !failures
      ? "✅ readFile became callable via tool_addition with the prefix cached"
      : "❌ check output above"
  );
  console.warn = warn;
  process.exit(enabledFirst && !failures ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.error ?? e);
  process.exit(1);
});
