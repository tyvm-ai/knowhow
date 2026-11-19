/**
 * Prompt-cache billing (Anthropic 1h writes, OpenAI GPT-5.6+ writes) and the
 * catalog's model info.
 */
import { GenericAnthropicClient } from "../../src/clients/anthropic";
import { GenericOpenAiClient } from "../../src/clients/openai";
import { getModelInfo } from "../../src/clients/pricing/modelInfo";
import { AIClient } from "../../src/clients";
import { OpenAiTextPricing } from "../../src/clients/pricing/openai";

describe("Anthropic cache-write billing", () => {
  const client = new GenericAnthropicClient("fake-key");

  it("bills 1h cache writes at 2× input and 5m writes at 1.25×", () => {
    // pob-buddy request 23: the first 1h request re-wrote 177,010 tokens.
    const oneHour = client.calculateCost("claude-fable-5-2", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 177_010,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 177_010 },
    } as any)!;
    expect(oneHour).toBeCloseTo(177_010 * 16 / 1e6, 6); // $2.83, was billed $1.77

    const fiveMin = client.calculateCost("claude-fable-5-2", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 177_010,
      cache_creation: { ephemeral_5m_input_tokens: 177_010, ephemeral_1h_input_tokens: 0 },
    } as any)!;
    expect(fiveMin).toBeCloseTo(177_010 * 10 / 1e6, 6);
  });

  it("splits mixed writes and keeps reads/output unchanged", () => {
    const cost = client.calculateCost("claude-haiku-4-5-20251001", {
      input_tokens: 100,
      output_tokens: 1_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 3_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
    } as any)!;
    const expected = (100 * 1 + 1_000 * 5 + 10_000 * 0.1 + 1_000 * 1.25 + 2_000 * 2) / 1e6;
    expect(cost).toBeCloseTo(expected, 9);
  });
});

describe("OpenAI cache-write billing", () => {
  const client = new GenericOpenAiClient("fake-key");

  it("bills GPT-5.6+ writes: 30m at cache_write, 12h at 2.5× input", () => {
    // The worked example from OpenAI's prompt-caching guide, at gpt-5.6-terra rates.
    const cost = client.calculateCost("gpt-5.6-terra", {
      prompt_tokens: 12_000,
      completion_tokens: 0,
      total_tokens: 12_000,
      prompt_tokens_details: {
        cached_tokens: 4_000,
        cache_write_tokens: 7_000,
        cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
      },
    } as any)!;
    const expected = (1_000 * 2 + 4_000 * 0.2 + 3_000 * 2.5 + 4_000 * 5) / 1e6;
    expect(cost).toBeCloseTo(expected, 9);
  });

  it("is unchanged for models that report no cache writes", () => {
    const cost = client.calculateCost("gpt-5.4", {
      prompt_tokens: 10_000,
      completion_tokens: 100,
      total_tokens: 10_100,
      prompt_tokens_details: { cached_tokens: 8_000 },
    } as any)!;
    const p = OpenAiTextPricing["gpt-5.4"];
    expect(cost).toBeCloseTo(
      (2_000 * p.input! + 8_000 * p.cached_input! + 100 * p.output!) / 1e6,
      9
    );
  });
});

describe("model info", () => {
  it("is one catalog lookup for capabilities and lifecycle", () => {
    const fable = new AIClient().getModelInfo("anthropic", "claude-fable-5-2");
    expect(fable.inCatalog).toBe(true);
    expect(fable.info.reasoning).toBe("always");
    expect(fable.info.toolAdditions).toBe(true);
    expect(fable.info.promptCache?.ttls?.map((t) => t.id)).toEqual(["5m", "1h"]);

    const gemini = getModelInfo("gemini-2.5-flash", "google");
    expect(gemini.routesTo).toBeDefined();
    expect(gemini.info.promptCache?.mode).toBe("automatic");

    expect(getModelInfo("grok-4.3", "xai").info.promptCache?.routingKey).toBe("x-grok-conv-id");
    expect(getModelInfo("gpt-5.4", "openai").info.useResponsesApi).toBe(true);
    expect(getModelInfo("unknown-model", "openai").inCatalog).toBe(false);
  });

  it("is exposed on the catalog entries", () => {
    const { ALL_MODEL_CATALOG } = require("../../src/clients/pricing");
    const entry = ALL_MODEL_CATALOG.find((e: any) => e.id === "gpt-5.6-terra");
    expect(entry.info.promptCache.ttls[0]).toMatchObject({ id: "30m", writeMultiplier: 1.25 });
    expect(entry.pricing.info).toBeUndefined();
  });
});
