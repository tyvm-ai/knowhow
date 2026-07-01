import { Models, EmbeddingModels } from "../types";

/**
 * Context window limits (in tokens) for all supported models.
 * Sources:
 * - OpenAI: https://platform.openai.com/docs/models
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
 * - Google: https://ai.google.dev/gemini-api/docs/models
 * - xAI: https://docs.x.ai/developers/models
 */
export const ContextLimits: Record<string, number> = {
  // ─── OpenAI ───────────────────────────────────────────────────────────────
  [Models.openai.GPT_55]: 1_000_000,
  [Models.openai.GPT_54]: 1_000_000,
  [Models.openai.GPT_54_Mini]: 400_000,
  [Models.openai.GPT_54_Nano]: 400_000,
  [Models.openai.GPT_54_Pro]: 1_000_000,
  [Models.openai.GPT_53_Chat]: 1_000_000,
  [Models.openai.GPT_53_Codex]: 1_000_000,
  [Models.openai.GPT_5]: 1_000_000,
  [Models.openai.GPT_5_Mini]: 1_000_000,
  [Models.openai.GPT_5_Nano]: 1_000_000,
  [Models.openai.GPT_51]: 1_000_000,
  [Models.openai.GPT_52]: 1_000_000,
  [Models.openai.GPT_41]: 1_047_576,
  [Models.openai.GPT_41_Mini]: 1_047_576,
  [Models.openai.GPT_41_Nano]: 1_047_576,
  [Models.openai.GPT_45]: 128_000,
  [Models.openai.GPT_4o]: 128_000,
  [Models.openai.GPT_4o_Mini]: 128_000,
  [Models.openai.GPT_4o_Audio]: 128_000,
  [Models.openai.GPT_4o_Realtime]: 128_000,
  [Models.openai.GPT_4o_Mini_Audio]: 128_000,
  [Models.openai.GPT_4o_Mini_Realtime]: 128_000,
  [Models.openai.GPT_4o_Mini_Search]: 128_000,
  [Models.openai.GPT_4o_Search]: 128_000,
  [Models.openai.o1]: 200_000,
  [Models.openai.o1_Mini]: 128_000,
  [Models.openai.o1_Pro]: 200_000,
  [Models.openai.o3]: 200_000,
  [Models.openai.o3_Pro]: 200_000,
  [Models.openai.o3_Mini]: 200_000,
  [Models.openai.o4_Mini]: 200_000,
  // ─── OpenAI (aliases / deprecated / non-text) ─────────────────────────────
  [Models.openai.GPT_55_Pro]: 1_000_000,
  [Models.openai.GPT_53_Codex_Spark]: 1_000_000,
  [Models.openai.GPT_52_Chat]: 1_000_000,
  [Models.openai.GPT_52_Codex]: 1_000_000,
  [Models.openai.GPT_52_Pro]: 1_000_000,
  [Models.openai.GPT_51_Chat]: 1_000_000,
  [Models.openai.GPT_51_Codex]: 1_000_000,
  [Models.openai.GPT_51_Codex_Max]: 1_000_000,
  [Models.openai.GPT_51_Codex_Mini]: 1_000_000,
  [Models.openai.GPT_5_Pro]: 1_000_000,
  [Models.openai.GPT_5_Chat]: 1_000_000,
  [Models.openai.GPT_5_Codex]: 1_000_000,
  [Models.openai.o1_Preview]: 128_000,
  [Models.openai.o3_Deep_Research]: 200_000,
  [Models.openai.o4_Mini_Deep_Research]: 200_000,
  [Models.openai.GPT_4o_Transcribe]: 128_000,
  [Models.openai.GPT_4o_Mini_Transcribe]: 128_000,
  [Models.openai.GPT_Realtime_15]: 128_000,
  [Models.openai.GPT_Realtime_Mini]: 128_000,
  [Models.openai.GPT_4o_2024_05_13]: 128_000,
  [Models.openai.GPT_4o_2024_11_20]: 128_000,
  [Models.openai.GPT_35_Turbo]: 16_385,
  [Models.openai.GPT_4]: 8_192,
  [Models.openai.GPT_4_Turbo]: 128_000,
  // OpenAI image/video/audio models — no text context window
  [Models.openai.GPT_Image_2]: 0,
  [Models.openai.GPT_Image_15]: 0,
  [Models.openai.GPT_Image_1]: 0,
  [Models.openai.GPT_Image_1_Mini]: 0,
  [Models.openai.ChatGPT_Image]: 0,
  [Models.openai.TTS_1]: 0,
  [Models.openai.Whisper_1]: 0,
  [Models.openai.DALL_E_3]: 0,
  [Models.openai.DALL_E_2]: 0,
  [Models.openai.Sora]: 0,
  [Models.openai.Sora_2]: 0,
  [Models.openai.Sora_2_Pro]: 0,

  // ─── Anthropic ────────────────────────────────────────────────────────────
  [Models.anthropic.Opus4_8Fast]: 1_000_000,
  [Models.anthropic.Opus4_8]: 1_000_000,
  [Models.anthropic.Opus4_7]: 1_000_000,
  [Models.anthropic.Opus4_6]: 1_000_000,
  [Models.anthropic.Opus4_6Fast]: 1_000_000,
  [Models.anthropic.Sonnet4_6]: 1_000_000,
  [Models.anthropic.Opus4_5]: 1_000_000,
  [Models.anthropic.Opus4]: 200_000,
  [Models.anthropic.Opus4_1]: 200_000,
  [Models.anthropic.Sonnet4]: 200_000,
  [Models.anthropic.Sonnet4_5]: 200_000,
  [Models.anthropic.Haiku4_5]: 200_000,
  [Models.anthropic.Sonnet3_7]: 200_000,
  [Models.anthropic.Sonnet3_5]: 200_000,
  [Models.anthropic.Opus3]: 200_000,
  [Models.anthropic.Haiku3]: 200_000,
  [Models.anthropic.Haiku3_5]: 200_000,

  // ─── Anthropic (aliases / deprecated) ────────────────────────────────────
  [Models.anthropic.Sonnet3_5_20240620]: 200_000,
  [Models.anthropic.Haiku3_5_Latest]: 200_000,
  [Models.anthropic.Sonnet3]: 200_000,
  [Models.anthropic.Opus4_0]: 200_000,
  [Models.anthropic.Sonnet4_0]: 200_000,

  // ─── Google ───────────────────────────────────────────────────────────────
  [Models.google.Gemini_31_Pro_Preview]: 1_000_000,
  [Models.google.Gemini_31_Flash_Image_Preview]: 1_000_000,
  [Models.google.Gemini_31_Flash_Lite_Preview]: 1_000_000,
  [Models.google.Gemini_31_Flash_Live_Preview]: 1_000_000,
  [Models.google.Gemini_3_Flash_Preview]: 1_000_000,
  [Models.google.Gemini_3_Pro_Image_Preview]: 1_000_000,
  [Models.google.Gemini_25_Pro]: 1_000_000,
  [Models.google.Gemini_25_Flash]: 1_000_000,
  [Models.google.Gemini_25_Flash_Lite]: 1_000_000,
  [Models.google.Gemini_25_Flash_Preview]: 1_000_000,
  [Models.google.Gemini_25_Pro_Preview]: 1_000_000,
  [Models.google.Gemini_25_Flash_Image]: 1_000_000,
  [Models.google.Gemini_25_Flash_Live]: 1_000_000,
  [Models.google.Gemini_25_Flash_Preview_0417]: 1_000_000,
  [Models.google.Gemini_25_Flash_Image_Preview]: 1_000_000,
  [Models.google.Gemini_25_Flash_Native_Audio]: 1_000_000,
  [Models.google.Gemini_25_Flash_TTS]: 1_000_000,
  [Models.google.Gemini_25_Pro_TTS]: 1_000_000,
  // Google image/video generation models — no text context window; use 0
  [Models.google.Imagen_3]: 0,
  [Models.google.Imagen_4_Fast]: 0,
  [Models.google.Imagen_4_Ultra]: 0,
  [Models.google.Veo_2]: 0,
  [Models.google.Veo_3]: 0,
  [Models.google.Veo_3_Fast]: 0,
  [Models.google.Veo_3_1]: 0,
  [Models.google.Veo_3_1_Fast]: 0,
  [Models.google.Gemini_20_Flash]: 1_000_000,
  [Models.google.Gemini_20_Flash_Preview_Image_Generation]: 1_000_000,
  [Models.google.Gemini_20_Flash_Live]: 1_000_000,
  [Models.google.Gemini_20_Flash_TTS]: 1_000_000,
  [Models.google.Gemini_15_Flash]: 1_000_000,
  [Models.google.Gemini_15_Flash_8B]: 1_000_000,
  [Models.google.Gemini_15_Pro]: 2_000_000,

  // ─── xAI ──────────────────────────────────────────────────────────────────
  [Models.xai.Grok4_1_Fast_Reasoning]: 2_000_000,
  [Models.xai.Grok4_1_Fast_NonReasoning]: 2_000_000,
  [Models.xai.Grok_4_20_Reasoning]: 131_072,
  [Models.xai.Grok_4_20_NonReasoning]: 131_072,
  [Models.xai.Grok_4_20_MultiAgent]: 2_000_000,
  [Models.xai.GrokCodeFast]: 2_000_000,
  [Models.xai.Grok4]: 131_072,
  [Models.xai.Grok3Beta]: 131_072,
  [Models.xai.Grok3MiniBeta]: 131_072,
  [Models.xai.Grok3FastBeta]: 131_072,
  [Models.xai.Grok3MiniFastBeta]: 131_072,
  [Models.xai.Grok21212]: 131_072,
  [Models.xai.Grok2Vision1212]: 131_072,
  // ─── xAI (aliases / deprecated / image / video) ───────────────────────────
  [Models.xai.Grok2Latest]: 131_072,
  [Models.xai.Grok2VisionLatest]: 131_072,
  [Models.xai.Grok3Latest]: 131_072,
  [Models.xai.Grok3FastLatest]: 131_072,
  [Models.xai.Grok3MiniLatest]: 131_072,
  [Models.xai.Grok3MiniFastLatest]: 131_072,
  [Models.xai.GrokBeta]: 131_072,
  [Models.xai.GrokVisionBeta]: 131_072,
  [Models.xai.Grok4_1_Fast]: 2_000_000,
  [Models.xai.Grok4Fast]: 2_000_000,
  [Models.xai.Grok4FastNonReasoning]: 2_000_000,
  // xAI image/video models — no text context window
  [Models.xai.GrokImagineImage]: 0,
  [Models.xai.GrokImagineVideo]: 0,
  [Models.xai.Grok2Image1212]: 0,
};

/** Default fallback context window limit (tokens) used when a model is not found. */
export const DEFAULT_CONTEXT_LIMIT = 30_000;

/**
 * Returns the context window limit (in tokens) for a given model.
 * Falls back to DEFAULT_CONTEXT_LIMIT if the model is not recognized.
 */
export function getModelContextLimit(model: string): number {
  return ContextLimits[model] ?? DEFAULT_CONTEXT_LIMIT;
}
