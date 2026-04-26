/**
 * Text Completions Manual Test
 *
 * Tests text generation ("say hello in 5 words") across multiple models and providers.
 * Results are persisted to `completions.json` so that re-running the suite skips
 * models that have already been tested (avoiding unnecessary API spend).
 *
 * Run with:
 *   npx jest tests/manual/clients/completions.test.ts --testTimeout=60000 --runInBand
 */

import * as fs from "fs";
import * as path from "path";
import { AIClient } from "../../../src/clients";
import { Models } from "../../../src/types";
import { OpenAiChatModels, OpenAiReasoningModels, OpenAiResponsesOnlyModels } from "../../../src/clients/pricing/openai";
import { AnthropicTextModels, AnthropicLimitedAvailabilityModels } from "../../../src/clients/pricing/anthropic";
import { GoogleTextModels } from "../../../src/clients/pricing/google";
import { XaiTextModels, XaiDeprecatedTextModels } from "../../../src/clients/pricing/xai";

const OUTPUT_FILE = path.join(__dirname, "completions.json");
const PROMPT = "Say hello in 5 words.";

// ─── Models to test ──────────────────────────────────────────────────────────
// Derived from the canonical model constant lists per provider.
// Only active (non-deprecated) models are included.

interface ModelEntry {
  provider: string;
  model: string;
  envKey: string;
}

function openaiEntries(models: string[]): ModelEntry[] {
  return models.map((model) => ({ provider: "openai", model, envKey: "OPENAI_KEY" }));
}

function anthropicEntries(models: string[]): ModelEntry[] {
  return models.map((model) => ({ provider: "anthropic", model, envKey: "ANTHROPIC_API_KEY" }));
}

function googleEntries(models: string[]): ModelEntry[] {
  return models.map((model) => ({ provider: "google", model, envKey: "GEMINI_API_KEY" }));
}

function xaiEntries(models: string[]): ModelEntry[] {
  return models.map((model) => ({ provider: "xai", model, envKey: "XAI_API_KEY" }));
}

const TEST_MODELS: ModelEntry[] = [
  // OpenAI — all active chat + reasoning models + responses-API models
  // Deduplicate since some models appear in multiple lists
  ...openaiEntries([...new Set([...OpenAiChatModels, ...OpenAiReasoningModels, ...OpenAiResponsesOnlyModels])]),

  // Anthropic — active text models (limited availability excluded)
  ...anthropicEntries(AnthropicTextModels),

  // Google — all active text models
  ...googleEntries(GoogleTextModels),

  // XAI — active text models (deprecated grok-2 models excluded)
  ...xaiEntries(XaiTextModels),
];

// ─── Persistence helpers ──────────────────────────────────────────────────────

interface CompletionRecord {
  provider: string;
  model: string;
  prompt: string;
  response: string;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: any;
  };
  usd_cost?: number;
  durationMs?: number;
  testedAt: string;
}

type CompletionsJSON = Record<string, CompletionRecord>;

function loadResults(): CompletionsJSON {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8")) as CompletionsJSON;
    } catch {
      return {};
    }
  }
  return {};
}

function saveResults(results: CompletionsJSON): void {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");
}

function recordKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Text Completions – multi-provider model verification", () => {
  let client: AIClient;
  let results: CompletionsJSON;

  beforeAll(() => {
    client = new AIClient();
    results = loadResults();
  });

  afterAll(() => {
    saveResults(results);
    console.log(`\n📄 Results saved to: ${OUTPUT_FILE}`);
    console.log(`   Total records: ${Object.keys(results).length}`);
  });

  for (const { provider, model, envKey } of TEST_MODELS) {
    const key = recordKey(provider, model);

    test(`${provider} / ${model}`, async () => {
      // ── Skip if already recorded ──────────────────────────────────────────
      if (results[key]) {
        const rec = results[key];
        console.log(`⏭  Skipping (already tested on ${rec.testedAt})`);
        console.log(`   Response : "${rec.response}"`);
        console.log(`   Cost     : $${rec.usd_cost?.toFixed(8) ?? "unknown"}`);
        console.log(`   Duration : ${rec.durationMs != null ? rec.durationMs + "ms" : "unknown"}`);
        expect(rec.response).toBeTruthy();
        return;
      }

      // ── Skip if API key missing ───────────────────────────────────────────
      if (!process.env[envKey]) {
        console.log(`⏭  Skipping: ${envKey} not set`);
        return;
      }

      // ── Run completion ────────────────────────────────────────────────────
      const startMs = Date.now();
      const response = await client.createCompletion(provider, {
        model,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 2000,
        // Use low reasoning effort for all models that support it — keeps latency
        // and cost down while still verifying the model responds successfully.
        // For OpenAI this maps to reasoning_effort="low", for Gemini to
        // thinkingLevel="low" or thinkingBudget=1024, etc.
        reasoning_effort: "low",
      });
      const durationMs = Date.now() - startMs;

      const text = response.choices[0]?.message?.content ?? "";
      expect(text).toBeTruthy();

      const record: CompletionRecord = {
        provider,
        model,
        prompt: PROMPT,
        response: text,
        usage: response.usage ?? {},
        durationMs,
        usd_cost: response.usd_cost,
        testedAt: new Date().toISOString(),
      };

      results[key] = record;
      // Persist immediately so a mid-run failure doesn't lose earlier results
      saveResults(results);

      console.log(`✅ ${provider} / ${model}`);
      console.log(`   Response : "${text}"`);
      console.log(`   Tokens   : ${JSON.stringify(response.usage)}`);
      console.log(`   Cost     : $${response.usd_cost?.toFixed(8) ?? "unknown"}`);
      console.log(`   Duration : ${durationMs}ms`);
    }, 60_000);
  }
});
