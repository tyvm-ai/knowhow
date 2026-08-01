/**
 * Tests that all models included in the Models object (anthropic, openai, google, xai)
 * have a corresponding context limit recorded in ContextLimits.
 */
import { Models } from "../../src/types";
import { ContextLimits, getModelContextLimit, DEFAULT_CONTEXT_LIMIT } from "../../src/clients/contextLimits";
import {
  OpenAiTextPricing,
  GeminiTextPricing,
  AnthropicTextPricing,
  XaiTextPricing,
  FireworksTextPricing,
  FireworksEmbeddingPricing,
} from "../../src/clients/pricing";

// Model ids explicitly marked deprecated across all pricing tables. Deprecated
// models are allowed to be absent from ContextLimits — they can be trimmed from
// Models.* / the context-limit map without breaking anything, since cost
// tracking reads the *TextPricing tables directly by model id.
const deprecatedModelIds = new Set<string>(
  Object.entries({
    ...OpenAiTextPricing,
    ...GeminiTextPricing,
    ...AnthropicTextPricing,
    ...XaiTextPricing,
    ...FireworksTextPricing,
    ...FireworksEmbeddingPricing,
  } as Record<string, { deprecated?: boolean }>)
    .filter(([, p]) => p && p.deprecated === true)
    .map(([id]) => id)
);

describe("ContextLimits", () => {
  describe("coverage - all Models.* values have a recorded context limit", () => {
    const providers = Object.keys(Models) as Array<keyof typeof Models>;

    for (const provider of providers) {
      describe(`Models.${provider}`, () => {
        const providerModels = Models[provider] as Record<string, string>;
        const modelEntries = Object.entries(providerModels);

        it(`should have at least one model defined for ${provider}`, () => {
          expect(modelEntries.length).toBeGreaterThan(0);
        });

        for (const [key, modelId] of modelEntries) {
          const testFn = deprecatedModelIds.has(modelId) ? it.skip : it;
          testFn(`${provider}.${key} (${modelId}) should have a context limit`, () => {
            const limit = ContextLimits[modelId];
            expect(limit).toBeDefined();
            expect(typeof limit).toBe("number");
            // Non-text models (image/video/audio) are recorded as 0; text models must be > 0
            expect(limit).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(limit)).toBe(true);
          });
        }
      });
    }
  });

  describe("getModelContextLimit", () => {
    it("returns the correct limit for a known OpenAI model", () => {
      expect(getModelContextLimit(Models.openai.GPT_4o)).toBe(128_000);
    });

    it("returns the correct limit for a known Anthropic model", () => {
      expect(getModelContextLimit(Models.anthropic.Opus4)).toBe(200_000);
    });

    it("returns the correct limit for a known Google model", () => {
      expect(getModelContextLimit(Models.google.Gemini_15_Pro)).toBe(2_000_000);
    });

    it("returns the correct limit for a known xAI model", () => {
      expect(getModelContextLimit(Models.xai.Grok3Beta)).toBe(131_072);
    });

    it("returns DEFAULT_CONTEXT_LIMIT for an unknown model", () => {
      expect(getModelContextLimit("unknown-model-xyz")).toBe(DEFAULT_CONTEXT_LIMIT);
    });

    it("DEFAULT_CONTEXT_LIMIT is a positive number", () => {
      expect(DEFAULT_CONTEXT_LIMIT).toBeGreaterThan(0);
    });
  });

  describe("ContextLimits values are all valid numbers", () => {
    it("all recorded limits are non-negative finite numbers", () => {
      for (const [model, limit] of Object.entries(ContextLimits)) {
        expect(typeof limit).toBe("number");
        // 0 is allowed for non-text models (image/video/audio)
        expect(limit).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(limit)).toBe(true);
      }
    });
  });
});
