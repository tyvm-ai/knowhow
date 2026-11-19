/**
 * Live check for Gemini 4 Neon / Hydrogen through AIClient (paid, ~$0.01).
 *   npx tsx tests/manual/modalities/google.gemini4.ts
 *
 * For each model: reasoning "none" (→ low), "xhigh", and a tool call; checks
 * usd_cost matches the raw usage at the catalog price.
 */
import assert from "assert";
import { AIClient } from "../../../src/clients";
import { Models } from "../../../src/types";
import { GeminiPricing } from "../../../src/clients/pricing/google";

const client = new AIClient();
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<string>) {
  try {
    const msg = await fn();
    passed++;
    console.log(`✅ ${name} — ${msg}`);
  } catch (e: any) {
    failed++;
    console.log(`❌ ${name} — ${e?.message ?? e}`);
  }
}

function expectedCost(model: string, usage: any) {
  const p = GeminiPricing[model];
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const input = (usage.prompt_tokens - cached) * p.input + cached * (p.context_caching ?? p.input);
  return (input + usage.completion_tokens * p.output) / 1e6;
}

async function main() {
  // Default providers register asynchronously — wait for google.
  for (let i = 0; i < 50 && !(client.listAllModels() as any).google?.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const model of [Models.google.Gemini_4_Neon, Models.google.Gemini_4_Hydrogen]) {
    for (const effort of ["none", "xhigh"] as const) {
      await check(`${model} reasoning=${effort}`, async () => {
        const res = await client.createCompletion("google", {
          model,
          messages: [{ role: "user", content: "What is 17 * 23? Reply with just the number." }],
          reasoning_effort: effort,
          max_tokens: 4000,
        });
        const text = String(res.choices[0].message.content ?? "").trim();
        assert.ok(text.includes("391"), `unexpected answer: ${text}`);
        const exp = expectedCost(model, res.usage);
        assert.ok(Math.abs((res.usd_cost ?? 0) - exp) < 1e-9, `usd_cost ${res.usd_cost} != ${exp}`);
        const r = (res.usage as any)?.output_tokens_details?.reasoning_tokens ?? 0;
        return `"${text}" out=${res.usage.completion_tokens} (reasoning ${r}) $${res.usd_cost?.toFixed(6)}`;
      });
    }

    await check(`${model} tool call`, async () => {
      const res = await client.createCompletion("google", {
        model,
        messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "getWeather",
              description: "Get the weather for a city",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        reasoning_effort: "low",
        max_tokens: 4000,
      });
      const call = res.choices[0].message.tool_calls?.[0];
      assert.ok(call, "no tool call");
      assert.strictEqual(call.function.name, "getWeather");
      return `${call.function.name}(${call.function.arguments}) $${res.usd_cost?.toFixed(6)}`;
    });
  }

  await check("catalog", async () => {
    for (const model of [Models.google.Gemini_4_Neon, Models.google.Gemini_4_Hydrogen]) {
      const info = client.getModelInfo("google", model);
      assert.ok(info, `no catalog entry for ${model}`);
    }
    return "both registered";
  });

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
