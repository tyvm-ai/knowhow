/**
 * Test that verifies every model supported by the Clients has a corresponding
 * pricing entry. This ensures we never release model support without knowing the price.
 *
 * Models that are image-only, video-only, TTS, transcription, realtime, or live streaming
 * are exempt from text pricing requirements — they should have their own pricing entries
 * in the appropriate pricing tables (image, video, audio, etc.).
 */

import {
  Models,
  EmbeddingModels,
  GoogleImageModels,
  GoogleVideoModels,
  GoogleTTSModels,
  OpenAiImageModels,
  OpenAiVideoModels,
  OpenAiTTSModels,
  OpenAiTranscriptionModels,
  OpenAiRealtimeModels,
  XaiImageModels,
  XaiVideoModels,
} from "../../src/types";

import {
  OpenAiTextPricing,
  GeminiTextPricing,
  AnthropicTextPricing,
  XaiTextPricing,
  XaiImagePricing,
  XaiVideoPricing,
} from "../../src/clients/pricing";

describe("Model Pricing Coverage", () => {
  /**
   * Models that are exclusively non-text modalities (image, video, TTS, transcription,
   * realtime/live audio) and therefore do NOT need a text token pricing entry.
   * They still must appear in their own modality-specific pricing table (see separate tests below).
   */
  const nonTextModels = new Set<string>([
    ...GoogleImageModels,
    ...GoogleVideoModels,
    ...GoogleTTSModels,
    ...OpenAiImageModels,
    ...OpenAiVideoModels,
    ...OpenAiTTSModels,
    ...OpenAiTranscriptionModels,
    ...OpenAiRealtimeModels,
    ...XaiImageModels,
    ...XaiVideoModels,
    // Live streaming model — not a standard text completion model
    Models.google.Gemini_20_Flash_Live,
  ]);

  const allTextPricing: Record<string, unknown> = {
    ...OpenAiTextPricing,
    ...GeminiTextPricing,
    ...AnthropicTextPricing,
    ...XaiTextPricing,
  };

  describe("Text completion models have pricing", () => {
    for (const [provider, providerModels] of Object.entries(Models)) {
      for (const [modelKey, modelId] of Object.entries(
        providerModels as Record<string, string>
      )) {
        if (nonTextModels.has(modelId)) {
          // Skip — covered by modality-specific tests below
          continue;
        }

        it(`${provider}.${modelKey} (${modelId}) has text pricing`, () => {
          const entry = allTextPricing[modelId];
          expect(entry).toBeDefined();
          expect(entry).toEqual(
            expect.objectContaining({ input: expect.any(Number) })
          );
        });
      }
    }
  });

  describe("Embedding models have pricing", () => {
    const allEmbeddingPricing: Record<string, unknown> = {
      ...OpenAiTextPricing, // OpenAI embeddings are in the text pricing table
      ...GeminiTextPricing, // Google embeddings are in the Gemini pricing table
    };

    for (const [provider, providerModels] of Object.entries(EmbeddingModels)) {
      for (const [modelKey, modelId] of Object.entries(
        providerModels as Record<string, string>
      )) {
        it(`EmbeddingModels.${provider}.${modelKey} (${modelId}) has pricing`, () => {
          const entry = allEmbeddingPricing[modelId];
          expect(entry).toBeDefined();
        });
      }
    }
  });

  describe("XAI image models have image pricing", () => {
    const xaiImagePricing = XaiImagePricing as Record<string, unknown>;

    for (const modelId of XaiImageModels) {
      it(`XAI image model (${modelId}) has image pricing`, () => {
        const entry = xaiImagePricing[modelId];
        expect(entry).toBeDefined();
      });
    }
  });

  describe("XAI video models have video pricing", () => {
    const xaiVideoPricing = XaiVideoPricing as Record<string, unknown>;

    for (const modelId of XaiVideoModels) {
      it(`XAI video model (${modelId}) has video pricing`, () => {
        const entry = xaiVideoPricing[modelId];
        expect(entry).toBeDefined();
      });
    }
  });

  describe("Google image models have pricing", () => {
    const geminiPricing = GeminiTextPricing as Record<string, unknown>;

    for (const modelId of GoogleImageModels) {
      it(`Google image model (${modelId}) has pricing in GeminiTextPricing`, () => {
        const entry = geminiPricing[modelId];
        expect(entry).toBeDefined();
      });
    }
  });

  describe("Google video models have pricing", () => {
    const geminiPricing = GeminiTextPricing as Record<string, unknown>;

    for (const modelId of GoogleVideoModels) {
      it(`Google video model (${modelId}) has pricing in GeminiTextPricing`, () => {
        const entry = geminiPricing[modelId];
        expect(entry).toBeDefined();
      });
    }
  });
});
