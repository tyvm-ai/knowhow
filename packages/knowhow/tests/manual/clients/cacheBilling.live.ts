/**
 * Manual live test: prompt-cache hits and cache-write billing per provider.
 *
 * For each model, sends the same ~8k-token prefix three times with a stable
 * cache_key and checks:
 *   - the 2nd/3rd requests read the cache,
 *   - usd_cost matches an independent calculation from the raw usage
 *     (GPT-5.6+: writes 1.25× input for 30m) or, for xAI, the cost xAI bills.
 *
 * Run: npx tsx tests/manual/clients/cacheBilling.live.ts   (well under $0.05)
 */
import { GenericOpenAiClient } from "../../../src/clients/openai";
import { GenericXAIClient } from "../../../src/clients/xai";
import { CompletionOptions, GenericClient } from "../../../src/clients/types";
import { OpenAiTextPricing } from "../../../src/clients/pricing/openai";
import { getModelInfo } from "../../../src/clients/pricing/modelInfo";

const nonce = `${Date.now()}-${Math.random()}`;
const prefix =
  `Reference ${nonce}.\n` +
  Array.from({ length: 900 }, (_, i) => `Fact ${i}: item${i} alpha beta gamma.`).join("\n");

function openAiExpected(model: string, usage: any): number {
  const p = OpenAiTextPricing[model];
  const d = usage.prompt_tokens_details ?? {};
  const write = d.cache_write_tokens ?? 0;
  const w12 = d.cache_write_tokens_details?.ttl_12h_tokens ?? 0;
  const fresh = usage.prompt_tokens - (d.cached_tokens ?? 0) - write;
  return (
    (fresh * p.input! +
      (d.cached_tokens ?? 0) * p.cached_input! +
      (write - w12) * p.input! * 1.25 +
      w12 * p.input! * 2.5 +
      usage.completion_tokens * p.output!) /
    1e6
  );
}

async function run(
  label: string,
  client: GenericClient,
  model: string,
  expected?: (usage: any) => number
): Promise<boolean> {
  const cache = getModelInfo(model).info.promptCache;
  console.log(`\n${label} ${model} (cache: ${cache?.mode}${cache?.ttls ? " " + cache.ttls.map((t) => t.id).join("/") : ""})`);
  let ok = true;
  let hits = 0;
  for (let i = 0; i < 3; i++) {
    const options: CompletionOptions = {
      model,
      messages: [
        { role: "system", content: prefix },
        { role: "user", content: `Reply with just OK. (${i})` },
      ],
      max_tokens: 200,
      reasoning_effort: "low",
      cache_key: `cache-billing-${nonce}`,
    };
    const response = await client.createChatCompletion(options);
    const u: any = response.usage;
    const d = u.prompt_tokens_details ?? {};
    if (i > 0 && d.cached_tokens > 0) hits++;
    const want = expected?.(u);
    const match = want === undefined || Math.abs(want - (response.usd_cost ?? 0)) < 1e-9;
    ok &&= match;
    console.log(
      `  #${i + 1} prompt=${u.prompt_tokens} cached=${d.cached_tokens ?? 0} write=${d.cache_write_tokens ?? "-"} ` +
        `out=${u.completion_tokens} usd_cost=$${response.usd_cost?.toFixed(7)}` +
        (want === undefined ? "" : match ? " ✓" : ` ✗ expected $${want.toFixed(7)}`)
    );
  }
  const hit = hits > 0;
  console.log(`  ${hit ? "✅" : "❌"} cache hits on repeat requests; ${ok ? "✅" : "❌"} billing`);
  return hit && ok;
}

async function main() {
  const openai = new GenericOpenAiClient(process.env.OPENAI_KEY || process.env.OPENAI_API_KEY);
  const results = [
    await run("OpenAI (explicit 30m)", openai, "gpt-5.6-luna", (u) => openAiExpected("gpt-5.6-luna", u)),
    await run("OpenAI (best-effort)", openai, "gpt-5.4-nano", (u) => openAiExpected("gpt-5.4-nano", u)),
    // xAI usd_cost is xAI's billed cost (usage.cost_in_usd_ticks).
    await run("xAI (best-effort, x-grok-conv-id)", new GenericXAIClient(), "grok-4.3"),
  ];
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
