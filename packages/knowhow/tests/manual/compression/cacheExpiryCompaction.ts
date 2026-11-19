/**
 * Manual live test: compaction runs on the WARM cache before it expires while
 * the agent is blocked on a long tool call.
 *
 * Within an agent's first 5 minutes its requests use Anthropic's 5m cache, so
 * the pre-expiry check fires 3 minutes after the last request. The agent:
 *   1. reads a big (~80k token) file, 2. notes progress, 3. sleeps ~3.5 min,
 *   4. answers. While it sleeps, the check compacts the thread (the compaction
 *      calls should READ the cache), and the request after the sleep should
 *      send the small compacted thread instead of re-writing 80k tokens.
 *
 * Run: npx tsx tests/manual/compression/cacheExpiryCompaction.ts [model]
 * (~4 minutes; under $0.05 on claude-haiku-5-5)
 */
import { BaseAgent } from "../../../src/agents/base/base";
import { ToolsService } from "../../../src/services/Tools";
import { EventService } from "../../../src/services/EventService";
import { Message, Tool } from "../../../src/clients/types";
import { Clients } from "../../../src/clients";
import { GenericAnthropicClient } from "../../../src/clients/anthropic";

const model = process.argv[2] || "claude-haiku-5-5";
const SLEEP_MS = 3.5 * 60_000;
const nonce = Date.now();

class ExpiryAgent extends BaseAgent {
  name = "ExpiryAgent";
  description = "pre-expiry compaction test";
  async getInitialMessages(userInput: string): Promise<Message[]> {
    return [
      { role: "system", content: `You follow instructions exactly. Run ${nonce}.` },
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

async function main() {
  Clients.registerClient("anthropic", new GenericAnthropicClient());
  Clients.registerModels("anthropic", [model]);
  const tools = new ToolsService();
  tools.addTools([
    tool("readBigFile", "Read the big data file."),
    tool("noteProgress", "Record a short progress note."),
    tool("sleep", "Wait for the background job to finish."),
    tool("finalAnswer", "Finish with the answer in `note`."),
  ]);
  tools.addFunctions({
    readBigFile: () =>
      Array.from({ length: 6000 }, (_, i) => `row ${i} ${nonce}: metric=${(i * 37) % 101}`).join("\n"),
    noteProgress: () => "noted",
    sleep: () => new Promise((resolve) => setTimeout(() => resolve("job finished"), SLEEP_MS)),
    finalAnswer: ({ note }: { note?: string }) => note || "done",
  });

  const agent = new ExpiryAgent({ Tools: tools, Events: new EventService() } as any);
  agent.setProvider("anthropic" as any);
  agent.setModel(model);

  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
  agent.agentEvents.on(agent.eventTypes.agentLog, (e: any) => {
    if (e.level !== "info" || /compact|cache expires|Compress/i.test(e.message)) console.log(`${at()} LOG ${e.message}`);
  });
  const requests: any[] = [];
  agent.agentEvents.on(agent.eventTypes.tokenUsage, (u: any) => {
    requests.push(u);
    console.log(
      `${at()} request #${requests.length}: read=${u.cacheReadTokens} write=${u.cacheWriteTokens} fresh=${u.inputTokens} out=${u.outputTokens}`
    );
  });

  agent.newTask(`expiry-${nonce}`);
  const answer = await agent.call(
    "Do these steps one tool call at a time, never in parallel: 1) call readBigFile, " +
      "2) call noteProgress with a one-line note, 3) call sleep, 4) call finalAnswer with note 'done'."
  );
  console.log(`\n${at()} answer: ${answer}`);
  console.log(`threads: ${agent.getThreads().length}, total cost: $${agent.getTotalCostUsd().toFixed(5)}`);

  const last = requests[requests.length - 1];
  const prompt = last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens;
  const ok = agent.getThreads().length === 2 && prompt < 20_000;
  console.log(
    ok
      ? `✅ compacted before expiry: final request sent ${prompt} tokens`
      : `❌ final request sent ${prompt} tokens (threads=${agent.getThreads().length})`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
