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

const OUTPUT_FILE = path.join(__dirname, "completions.json");
const PROMPT = "Say hello in 5 words.";

// ─── Models to test ──────────────────────────────────────────────────────────
// One or two representative, cheap/fast models per provider.

interface ModelEntry {
  provider: string;
  model: string;
  envKey: string;
}

const TEST_MODELS: ModelEntry[] = [
  // OpenAI
  { provider: "openai", model: Models.openai.GPT_4o_Mini,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_41_Nano,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_54,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_54_Pro,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_54_Mini,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_54_Nano,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_53_Chat,  envKey: "OPENAI_KEY" },
  { provider: "openai", model: Models.openai.GPT_53_Codex,  envKey: "OPENAI_KEY" },

  // Anthropic
  { provider: "anthropic", model: Models.anthropic.Haiku4_5, envKey: "ANTHROPIC_API_KEY" },
  { provider: "anthropic", model: Models.anthropic.Sonnet4_6, envKey: "ANTHROPIC_API_KEY" },
  { provider: "anthropic", model: Models.anthropic.Opus4_6, envKey: "ANTHROPIC_API_KEY" },

  // Google
  { provider: "google", model: Models.google.Gemini_25_Flash,      envKey: "GEMINI_API_KEY" },
  { provider: "google", model: Models.google.Gemini_31_Flash_Lite_Preview,      envKey: "GEMINI_API_KEY" },
  { provider: "google", model: Models.google.Gemini_31_Flash_Image_Preview,      envKey: "GEMINI_API_KEY" },
  { provider: "google", model: Models.google.Gemini_31_Pro_Preview,      envKey: "GEMINI_API_KEY" },

  // XAI
  { provider: "xai", model: Models.xai.Grok3MiniFastBeta, envKey: "XAI_API_KEY" },
  { provider: "xai", model: Models.xai.Grok3MiniBeta,     envKey: "XAI_API_KEY" },
  { provider: "xai", model: Models.xai.Grok4,     envKey: "XAI_API_KEY" },
  { provider: "xai", model: Models.xai.Grok4_1_Fast_NonReasoning,     envKey: "XAI_API_KEY" },
  { provider: "xai", model: Models.xai.Grok4_1_Fast_NonReasoning,     envKey: "XAI_API_KEY" },
  { provider: "xai", model: Models.xai.Grok_4_20_NonReasoning,     envKey: "XAI_API_KEY" },
  { provider: "xai", model: Models.xai.Grok_4_20_Reasoning,     envKey: "XAI_API_KEY" },
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
        expect(rec.response).toBeTruthy();
        return;
      }

      // ── Skip if API key missing ───────────────────────────────────────────
      if (!process.env[envKey]) {
        console.log(`⏭  Skipping: ${envKey} not set`);
        return;
      }

      // ── Run completion ────────────────────────────────────────────────────
      const response = await client.createCompletion(provider, {
        model,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 50,
      });

      const text = response.choices[0]?.message?.content ?? "";
      expect(text).toBeTruthy();

      const record: CompletionRecord = {
        provider,
        model,
        prompt: PROMPT,
        response: text,
        usage: response.usage ?? {},
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
    }, 60_000);
  }
});
