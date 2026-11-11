/**
 * Google (Gemini) — newest models live verification script (Nov 2026 batch)
 *
 * Exercises every newly added Google model end-to-end through AIClient:
 *  1. gemini-decision-1         — Decisions API (noul / choice / score) + pricing
 *  2. gemini-decision-1         — default model, Jev-style criteria, structured state
 *  3. gemini-4-carbon           — chat completion, reasoning_effort "none" → low
 *  4. gemini-3.8-flash-tts      — TTS → outputs/google/<model>.wav
 *  5. gemini-3.8-flash-lite-tts — TTS → outputs/google/<model>.wav
 *  6. gemini-nano-banana-2.1    — image generation → outputs/google/nano-banana-2.1.png
 *  7. registry / catalog        — models registered with pricing + modality
 *
 * NOTE: this is a plain tsx script rather than a jest test because the
 * @google/genai SDK fails under jest ("Undici globalDispatcher is not available").
 *
 * Requires GEMINI_API_KEY (paid tier — Gemini 4 Carbon has no free tier).
 *
 * Run with:
 *   npx tsx tests/manual/modalities/google.newModels.ts
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { GeminiPricing, GOOGLE_MODEL_CATALOG } from "../../../src/clients/pricing";
import { Models } from "../../../src/types";

const OUTPUT_DIR = path.join(__dirname, "outputs", "google");

const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string>) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`✅ ${name} (${Date.now() - start}ms) — ${detail}`);
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ name, ok: false, detail });
    console.log(`❌ ${name} (${Date.now() - start}ms) — ${detail}`);
  }
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const client = new AIClient();
  // Default providers register asynchronously — wait for google's modalities.
  for (let i = 0; i < 50 && !client.listAllDecisionModels().google; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await check("1. gemini-decision-1 noul/choice/score", async () => {
    const res = await client.decide("google", {
      model: Models.google.Gemini_Decision_1,
      state:
        "The blue mug I ordered on Monday arrived cracked on Wednesday. I want a refund today!",
      questions: {
        is_damaged: {
          type: "noul",
          instructions: "Did the item arrive damaged?",
          criteria: {
            true_description: "The product itself is broken or faulty.",
            false_description: "Preference, sizing, shipping, or pricing complaint.",
          },
        },
        department: {
          type: "choice",
          instructions: "Which department should handle this request?",
          criteria: {
            billing: "Payments, invoices, and refunds.",
            technical: "Problems using the product.",
            shipping: "Delivery, tracking, and items damaged in transit.",
            other: "Anything outside these categories.",
          },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this customer's request?",
          criteria: ["Not urgent", "Somewhat urgent", "Extremely urgent"],
        },
      },
    });
    assert.strictEqual(res.model, Models.google.Gemini_Decision_1);
    const d = res.answers.is_damaged;
    assert.ok(d.type === "noul" && d.noul > 0.5, "expected is_damaged > 0.5");
    const dept = res.answers.department;
    assert.ok(dept.type === "choice");
    const total = Object.values(dept.probabilities).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 0.05, `choice probabilities sum to ${total}`);
    const u = res.answers.urgency;
    assert.ok(u.type === "score" && u.score >= 0 && u.score <= 2);
    assert.ok(res.usage.input_tokens > 0);
    assert.strictEqual(res.usage.output_tokens, 0);
    const expected = (res.usage.input_tokens * 0.1) / 1_000_000;
    assert.ok(Math.abs((res.usd_cost ?? -1) - expected) < 1e-12, "usd_cost mismatch");
    return `damaged=${d.type === "noul" ? d.noul : "?"} dept=${dept.choice} urgency=${u.type === "score" ? u.score.toFixed(2) : "?"} in=${res.usage.input_tokens} cost=$${res.usd_cost}`;
  });

  await check("2. gemini-decision-1 default model + Jev-style criteria + JSON state", async () => {
    const res = await client.decide("google", {
      state: { order: { id: "8821", item: "headphones" }, message: "Left earcup has no sound." },
      questions: {
        is_defect: {
          type: "noul",
          instructions: "Is the customer reporting a product defect?",
          criteria: { true: "Product is broken", false: "Not a defect" },
        },
      },
    });
    assert.strictEqual(res.model, Models.google.Gemini_Decision_1);
    const a = res.answers.is_defect;
    assert.ok(a.type === "noul" && a.noul > 0.5, "expected is_defect > 0.5");
    return `is_defect=${a.type === "noul" ? a.noul : "?"} confidence=${a.type === "noul" ? a.confidence : "?"}`;
  });

  await check("3. gemini-4-carbon completion", async () => {
    const res = await client.createCompletion("google", {
      model: Models.google.Gemini_4_Carbon,
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      max_tokens: 32768,
      reasoning_effort: "none",
    });
    const text = res.choices[0]?.message?.content ?? "";
    assert.ok(text.toLowerCase().includes("pong"), `unexpected reply: ${text}`);
    assert.ok((res.usd_cost ?? 0) > 0, "expected non-zero cost");
    return `reply=${JSON.stringify(text.trim())} cost=$${res.usd_cost}`;
  });

  for (const [label, model] of [
    ["4. gemini-3.8-flash-tts", Models.google.Gemini_38_Flash_TTS],
    ["5. gemini-3.8-flash-lite-tts", Models.google.Gemini_38_Flash_Lite_TTS],
  ] as const) {
    await check(label, async () => {
      const res = await client.createAudioGeneration("google", {
        model,
        input: "Hello from the newest Gemini text to speech model.",
        voice: "Puck",
      });
      assert.ok(res.audio.length > 1000, "audio too small");
      const out = path.join(OUTPUT_DIR, `${model}.wav`);
      fs.writeFileSync(out, res.audio);
      return `${res.audio.length} bytes → ${out}`;
    });
  }

  await check("6. gemini-nano-banana-2.1 image", async () => {
    const res = await client.createImageGeneration("google", {
      model: Models.google.Gemini_Nano_Banana_21,
      prompt: "A small yellow banana wearing sunglasses, flat illustration",
    });
    const img = res.data[0];
    assert.ok(img?.b64_json || img?.url, "no image returned");
    if (img?.b64_json) {
      const out = path.join(OUTPUT_DIR, "nano-banana-2.1.png");
      fs.writeFileSync(out, Buffer.from(img.b64_json, "base64"));
      return `saved → ${out} cost=$${res.usd_cost}`;
    }
    return `url=${img?.url}`;
  });

  await check("7. registry / catalog / pricing", async () => {
    const type = (id: string) => GOOGLE_MODEL_CATALOG.find((m) => m.id === id)?.type;
    assert.strictEqual(type(Models.google.Gemini_Decision_1), "decision");
    assert.strictEqual(type(Models.google.Gemini_4_Carbon), "completion");
    assert.strictEqual(type(Models.google.Gemini_38_Flash_TTS), "audio");
    assert.strictEqual(type(Models.google.Gemini_38_Flash_Lite_TTS), "audio");
    assert.strictEqual(type(Models.google.Gemini_Nano_Banana_21), "image");
    assert.strictEqual(GeminiPricing[Models.google.Gemini_Decision_1].input, 0.1);
    assert.strictEqual(GeminiPricing[Models.google.Gemini_4_Carbon].input, 2);
    assert.strictEqual(GeminiPricing[Models.google.Gemini_4_Carbon].output, 10);
    assert.ok(
      client.listAllDecisionModels().google?.includes(Models.google.Gemini_Decision_1),
      "gemini-decision-1 not registered as a google decision model"
    );
    return "ok";
  });

  for (const [label, from, to] of [
    ["8. deprecated gemini-3.7-flash → 3.8-flash", Models.google.Gemini_37_Flash, Models.google.Gemini_38_Flash],
    ["9. deprecated gemini-3.5-flash → 3.6-flash", Models.google.Gemini_35_Flash, Models.google.Gemini_36_Flash],
  ] as const) {
    await check(label, async () => {
      assert.strictEqual(client.getClient("google", from).model, to, "not rerouted");
      const res = await client.createCompletion("google", {
        model: from,
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
        max_tokens: 2048,
        reasoning_effort: "low",
      });
      const text = res.choices[0]?.message?.content ?? "";
      assert.ok(text.toLowerCase().includes("pong"), `unexpected reply: ${text}`);
      assert.ok(String(res.model).includes(to), `served by ${res.model}, expected ${to}`);
      return `served by ${res.model} cost=$${res.usd_cost}`;
    });
  }

  await check("10. gemini-2.5-pro / 2.5-flash deprecated, reroute scheduled 2026-12-01", async () => {
    const entry = (id: string) => GOOGLE_MODEL_CATALOG.find((m) => m.id === id)!;
    const pro = entry(Models.google.Gemini_25_Pro);
    const flash = entry(Models.google.Gemini_25_Flash);
    assert.ok(pro.deprecated && flash.deprecated);
    assert.strictEqual(pro.routesTo, Models.google.Gemini_38_Flash);
    assert.strictEqual(flash.routesTo, Models.google.Gemini_35_Flash_Lite);
    assert.strictEqual(pro.routesToDate, "2026-12-01");
    assert.strictEqual(flash.routesToDate, "2026-12-01");
    const expectedPro = new Date() >= new Date("2026-12-01T00:00:00Z")
      ? Models.google.Gemini_38_Flash
      : Models.google.Gemini_25_Pro;
    assert.strictEqual(client.getClient("google", Models.google.Gemini_25_Pro).model, expectedPro);
    return `2.5-pro currently sent as ${expectedPro}`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
