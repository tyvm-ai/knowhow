/**
 * Manual live test: moving a thread from the 5m to the 1h prompt cache by
 * compacting on the WARM 5m cache.
 *
 * The switch time is lowered from 5 minutes to 30s so the run is short. The
 * agent reads a big file (5m cache write), sleeps past the switch time, then
 * keeps working. Expected request sequence:
 *   - thread 0 requests: ttl=5m, writes at 1.25×, then reads
 *   - compaction calls (tool_choice none): ttl=5m, READ the big prefix
 *   - thread 1 first request: ttl=1h, writes only the small compacted prefix
 *   - thread 1 later requests: ttl=1h, read it
 * Every request's usd_cost is checked against the raw Anthropic usage
 * (5m writes 1.25×, 1h writes 2× input).
 *
 * Run: npx tsx tests/manual/compression/ttlSwitchCompaction.ts [model]
 * (~1 minute; a few cents on claude-haiku-4-5)
 */
import { BaseAgent } from "../../../src/agents/base/base";
import { ToolsService } from "../../../src/services/Tools";
import { EventService } from "../../../src/services/EventService";
import { CompletionOptions, Message, Tool } from "../../../src/clients/types";
import { Clients } from "../../../src/clients";
import { GenericAnthropicClient } from "../../../src/clients/anthropic";
import { AnthropicTextPricing } from "../../../src/clients/pricing/anthropic";

const model = process.argv[2] || "claude-haiku-4-5-20251001";
const SWITCH_AFTER_MS = 30_000;
const SLEEP_MS = 35_000;
const nonce = Date.now();
const GUIDELINES = Array.from(
  { length: 400 },
  (_, i) => `Guideline ${i}: keep tool calls sequential and notes short (${(i * 7919) % 1000}).`
).join("\n");

class TtlAgent extends BaseAgent {
  name = "TtlAgent";
  description = "5m → compaction → 1h test";
  async getInitialMessages(userInput: string): Promise<Message[]> {
    return [
      // Large enough that the compacted thread clears the minimum cacheable
      // prefix (4096 tokens on Haiku 4.5), like a real agent system prompt.
      { role: "system", content: `You follow instructions exactly. Run ${nonce}.\n${GUIDELINES}` },
      { role: "user", content: userInput },
    ];
  }
}

const tool = (name: string, description: string): Tool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: { note: { type: "string", description: "optional note" } },
      required: [],
    },
  },
});

/** Independent cost from raw usage (per 1M: input, 5m write 1.25×, 1h write 2×, read). */
function expectedCost(usage: any): number {
  const p = AnthropicTextPricing[model];
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMin = (usage.cache_creation_input_tokens ?? 0) - oneHour;
  return (
    (usage.input_tokens * p.input! +
      fiveMin * p.input! * 1.25 +
      oneHour * p.input! * 2 +
      usage.cache_read_input_tokens * p.cache_hit! +
      usage.output_tokens * p.output!) /
    1e6
  );
}

async function main() {
  const client = new GenericAnthropicClient();
  Clients.registerClient("anthropic", client);
  Clients.registerModels("anthropic", [model]);

  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`;
  const rows: any[] = [];
  let billingOk = true;
  const original = client.createChatCompletion.bind(client);
  client.createChatCompletion = async (options: CompletionOptions) => {
    const response = await original(options);
    const u: any = response.usage;
    if (!u) return response;
    const ttl = options.long_ttl_cache ? "1h" : "5m";
    const kind = options.tool_choice === "none" ? "compaction" : "agent";
    const expected = expectedCost(u);
    const match = Math.abs(expected - (response.usd_cost ?? 0)) < 1e-9;
    billingOk &&= match;
    rows.push({ ttl, kind, u, cost: response.usd_cost });
    console.log(
      `${at()} ${kind.padEnd(10)} ttl=${ttl} read=${u.cache_read_input_tokens} ` +
        `write5m=${u.cache_creation?.ephemeral_5m_input_tokens ?? 0} write1h=${u.cache_creation?.ephemeral_1h_input_tokens ?? 0} ` +
        `fresh=${u.input_tokens} out=${u.output_tokens} cost=$${response.usd_cost?.toFixed(6)} ${match ? "✓" : `✗ expected $${expected.toFixed(6)}`}`
    );
    return response;
  };

  const tools = new ToolsService();
  tools.addTools([
    tool("readBigFile", "Read the big data file."),
    tool("noteProgress", "Record a short progress note."),
    tool("sleep", "Wait for the background job to finish."),
    tool("wait", "Wait briefly for the second job."),
    tool("finalAnswer", "Finish with the answer in `note`."),
  ]);
  tools.addFunctions({
    readBigFile: () =>
      Array.from({ length: 3000 }, (_, i) => `row ${i} ${nonce}: metric=${(i * 37) % 101}`).join("\n"),
    noteProgress: () => "noted",
    wait: () => new Promise((resolve) => setTimeout(() => resolve("second job finished"), 20_000)),
    sleep: () => new Promise((resolve) => setTimeout(() => resolve("job finished"), SLEEP_MS)),
    finalAnswer: ({ note }: { note?: string }) => note || "done",
  });

  const agent = new TtlAgent({ Tools: tools, Events: new EventService() } as any);
  agent.setProvider("anthropic" as any);
  agent.setModel(model);
  (agent as any).longTtlAfterMs = SWITCH_AFTER_MS;
  agent.agentEvents.on(agent.eventTypes.agentLog, (e: any) => {
    if (/compact|cache TTL|Task passed/i.test(e.message)) console.log(`${at()} LOG ${e.message}`);
  });

  agent.newTask(`ttl-${nonce}`);
  const answer = await agent.call(
    "Do these steps one tool call at a time, never in parallel: 1) call readBigFile, " +
      "2) call noteProgress with a one-line note, 3) call sleep, 4) call wait, 5) call noteProgress with 'a', " +
      "5) call noteProgress with 'b', 6) call noteProgress with 'c', 7) call noteProgress with 'd', " +
      "8) call finalAnswer with note 'done'."
  );
  console.log(`\n${at()} answer: ${answer}`);
  const threads = agent.getThreads().length;
  console.log(`threads: ${threads}, total cost: $${agent.getTotalCostUsd().toFixed(5)}`);

  const compactions = rows.filter((r) => r.kind === "compaction");
  const longRows = rows.filter((r) => r.ttl === "1h" && r.kind === "agent");
  const compactionReadWarm = compactions.length > 0 && compactions.every((r) => r.ttl === "5m" && r.u.cache_read_input_tokens > 20_000);
  const firstLong = longRows[0];
  const big = Math.max(...rows.map((r) => r.u.cache_read_input_tokens ?? 0));
  const smallLongWrite = !!firstLong && (firstLong.u.cache_creation?.ephemeral_1h_input_tokens ?? 0) < big / 2;
  const longHits = longRows.slice(1).some((r) => r.u.cache_read_input_tokens > 0);
  const checks: [string, boolean][] = [
    ["compaction calls read the warm 5m cache", compactionReadWarm],
    ["new thread wrote only the compacted prefix at 1h", smallLongWrite],
    ["later 1h requests hit the cache", longHits],
    ["usd_cost matches raw usage on every request", billingOk],
    ["two threads", threads === 2],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? "✅" : "❌"} ${name}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
