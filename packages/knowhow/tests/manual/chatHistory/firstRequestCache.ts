/**
 * Verifies the first request of a task writes the (string) first user
 * message to Anthropic's prompt cache instead of billing it uncached.
 *   npx tsx tests/manual/chatHistory/firstRequestCache.ts
 */
import { AIClient } from "../../../src/clients";
import { buildChatHistoryContext, ChatHistoryIndex } from "../../../src/services/ChatHistoryIndex";

async function main() {
  const client = new AIClient();
  const index = new ChatHistoryIndex({ root: "/Users/micah/dev/knowhow" });
  const ctx = await buildChatHistoryContext({ index, input: "what did we change about reasoning token billing?" });
  const prompt = `${ctx.text}\n<CurrentTask>In one sentence: what did we change about reasoning token billing? (nonce ${Date.now()})</CurrentTask>`;
  const model = process.env.MODEL || "claude-haiku-4-5";
  const messages: any[] = [
    { role: "system", content: "You are a terse assistant." },
    { role: "user", content: prompt },
  ];
  const first = await client.createCompletion("anthropic", { model, messages, max_tokens: 200 });
  console.log("request 1 usage", JSON.stringify(first.usage), "cost", first.usd_cost);
  messages.push({ role: "assistant", content: first.choices[0].message.content });
  messages.push({ role: "user", content: "Now in five words." });
  const second = await client.createCompletion("anthropic", { model, messages, max_tokens: 50 });
  console.log("request 2 usage", JSON.stringify(second.usage), "cost", second.usd_cost);
  console.log("answer:", first.choices[0].message.content);
  const u: any = first.usage;
  const written = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_write_tokens ?? 0;
  console.log(written > 1000 ? "✅ first request wrote the prompt to cache" : "❌ first request did not cache the prompt");
}
main().catch((e) => { console.error(e); process.exit(1); });
