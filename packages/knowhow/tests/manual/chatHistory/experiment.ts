/**
 * Chat history context experiment.
 *
 * Replays the last N terminal chat tasks of a project as if they had been
 * typed in one chat process, and compares the history block each strategy
 * would have sent with the task:
 *
 *   legacy        JSON.stringify(every interaction in this process) — today
 *   window4       last 4 interactions only
 *   window4+rel10 last 4 + 10 most similar older interactions (truncated)
 *   window2+rel10 last 2 + 10 most similar older interactions (truncated)
 *   window4+rel10full  same but older answers not truncated
 *
 * Tokens are counted with Anthropic's free count_tokens endpoint (calibrated
 * chars/token ratio per format), and the cost of carrying the block through a
 * task uses the real request counts from `.knowhow/processes/agents/<id>/usage.json`
 * when available (else the median), priced at claude-opus-5-5 rates:
 *   cost = H × (write 1.25×input + (requests − 1) × cache read)
 * (the first request currently pays H at the full input rate *plus* the write
 * when the first user message is a plain string — see "uncached first request").
 *
 *   npx tsx tests/manual/chatHistory/experiment.ts [projectRoot] [tasks=30]
 */
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  ChatHistoryIndex,
  ChatHistoryEntry,
  ChatHistoryOptions,
  buildChatHistoryContext,
} from "../../../src/services/ChatHistoryIndex";

const root = process.argv[2] || "/Users/micah/dev/knowhow";
const TASKS = Number(process.argv[3] || 30);
const PRICE = { input: 4.0, write: 5.0, read: 0.2 }; // claude-opus-5-5 per 1M

const strategies: Record<string, Partial<ChatHistoryOptions> | "legacy"> = {
  legacy: "legacy",
  window4: { recent: 4, relevant: 0, recentMaxAgeHours: 0 },
  "window4+rel10": { recent: 4, relevant: 10, recentMaxAgeHours: 0 },
  "window2+rel10": { recent: 2, relevant: 10, recentMaxAgeHours: 0 },
  "window4+rel10full": {
    recent: 4,
    relevant: 10,
    recentMaxAgeHours: 0,
    relevantInputChars: 0,
    relevantOutputChars: 0,
  },
};

function legacyBlock(previous: ChatHistoryEntry[]): string {
  const chatHistory = previous.map((e) => ({ input: e.input, output: e.output, taskId: e.id }));
  return `<PreviousChats>
  This information is provided as historical context and is likely not related to the current task:
  ${JSON.stringify(chatHistory)}
    </PreviousChats>`;
}

function requestCount(taskId: string): number | undefined {
  try {
    const usage = JSON.parse(
      fs.readFileSync(path.join(root, ".knowhow/processes/agents", taskId, "usage.json"), "utf8")
    );
    return Array.isArray(usage) ? usage.length : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const index = new ChatHistoryIndex({ root });
  await index.sync();
  const all = [...index.entries()].sort(
    (a, b) => (a.metadata.startTime ?? 0) - (b.metadata.startTime ?? 0)
  );
  const tasks = all.slice(-TASKS);
  const anthropic = new Anthropic();

  const counted = new Map<string, number>();
  async function countTokens(text: string): Promise<number> {
    if (!text) return 0;
    if (counted.has(text)) return counted.get(text)!;
    const res = await anthropic.messages.countTokens({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: text }],
    });
    const tokens = Math.max(0, res.input_tokens - 8); // minus message overhead
    counted.set(text, tokens);
    return tokens;
  }

  const counts = tasks.map((t) => requestCount(t.id)).filter((n): n is number => !!n);
  const sorted = [...counts].sort((a, b) => a - b);
  const medianRequests = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 25;
  console.log(
    `${all.length} indexed chat tasks; replaying last ${tasks.length}. ` +
      `Requests/task: median ${medianRequests} (real counts for ${counts.length} tasks)\n`
  );

  const totals: Record<string, { tokens: number; cost: number; uncachedFirst: number }> = {};
  for (const name of Object.keys(strategies)) totals[name] = { tokens: 0, cost: 0, uncachedFirst: 0 };
  const perTask: string[] = [];
  const samples: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const previous = tasks.slice(0, i); // same "process"
    const asOf = task.metadata.startTime ?? Date.now();
    const requests = requestCount(task.id) ?? medianRequests;
    const queryVector = await index.embed(task.input);
    const row: string[] = [`${String(i + 1).padStart(2)} ${task.id.slice(0, 38).padEnd(38)} req=${String(requests).padStart(3)}`];

    for (const [name, strategy] of Object.entries(strategies)) {
      let text: string;
      if (strategy === "legacy") {
        text = previous.length ? legacyBlock(previous) : "";
      } else {
        const ctx = await buildChatHistoryContext({
          index,
          input: task.input,
          options: strategy,
          asOf,
          queryVector,
        });
        text = ctx.text;
        if (name === "window4+rel10" && (i === tasks.length - 1 || i === Math.floor(tasks.length / 2))) {
          samples.push(
            `\n── retrieved for "${task.input.slice(0, 90)}" ──\n` +
              ctx.relevant
                .map((r) => {
                  const e = index.get(r.id)!;
                  return `  ${r.similarity.toFixed(3)}  ${e.input.slice(0, 100).replace(/\s+/g, " ")}`;
                })
                .join("\n")
          );
        }
      }
      const tokens = await countTokens(text);
      const cost = (tokens * (PRICE.write + (requests - 1) * PRICE.read)) / 1e6;
      totals[name].tokens += tokens;
      totals[name].cost += cost;
      totals[name].uncachedFirst += (tokens * PRICE.input) / 1e6;
      row.push(`${name}=${String(tokens).padStart(6)}`);
    }
    perTask.push(row.join("  "));
  }

  console.log(perTask.join("\n"));
  console.log("\nTotals over the replay (history block only):");
  for (const [name, t] of Object.entries(totals)) {
    console.log(
      `  ${name.padEnd(18)} avg ${String(Math.round(t.tokens / tasks.length)).padStart(6)} tok/task  ` +
        `cost $${t.cost.toFixed(2)}  (+$${t.uncachedFirst.toFixed(2)} if the first request isn't cached)`
    );
  }
  console.log(samples.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
