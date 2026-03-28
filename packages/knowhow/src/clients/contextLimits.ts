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
  [Models.openai.GPT_54]: 1_000_000,
  [Models.openai.GPT_54_Mini]: 400_000,
  [Models.openai.GPT_54_Nano]: 400_000,
  [Models.openai.GPT_54_Pro]: 1_000_000,
  [Models.openai.GPT_53_Chat]: 1_000_000,
  [Models.openai.GPT_53_Codex]: 1_000_000,
  [Models.openai.GPT_5]: 1_000_000,
  [Models.openai.GPT_5_Mini]: 1_000_000,
  [Models.openai.GPT_5_Nano]: 1_000_000,
  [Models.openai.GPT_5_1]: 1_000_000,
  [Models.openai.GPT_5_2]: 1_000_000,
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

  // ─── Anthropic ────────────────────────────────────────────────────────────
  [Models.anthropic.Opus4_6]: 1_000_000,
  [Models.anthropic.Sonnet4_6]: 1_000_000,
  [Models.anthropic.Opus4_5]: 1_000_000,
  [Models.anthropic.Opus4]: 200_000,
  [Models.anthropic.Opus4_1]: 200_000,
  [Models.anthropic.Sonnet4]: 200_000,
  [Models.anthropic.Sonnet4_5]: 200_000,
  [Models.anthropic.Haiku4_5]: 200_000,
  [Models.anthropic.Sonnet3_7]: 200_000,
  [Models.anthropic.Sonnet3_5]: 200_000,
  [Models.anthropic.Haiku3_5]: 200_000,
  [Models.anthropic.Opus3]: 200_000,
  [Models.anthropic.Haiku3]: 200_000,

  // ─── Google ───────────────────────────────────────────────────────────────
  [Models.google.Gemini_31_Pro_Preview]: 1_000_000,
  [Models.google.Gemini_31_Flash_Image_Preview]: 1_000_000,
  [Models.google.Gemini_31_Flash_Lite_Preview]: 1_000_000,
  [Models.google.Gemini_3_Flash_Preview]: 1_000_000,
  [Models.google.Gemini_3_Pro_Image_Preview]: 1_000_000,
  [Models.google.Gemini_25_Pro]: 1_000_000,
  [Models.google.Gemini_25_Flash]: 1_000_000,
  [Models.google.Gemini_25_Flash_Lite]: 1_000_000,
  [Models.google.Gemini_25_Flash_Preview]: 1_000_000,
  [Models.google.Gemini_25_Pro_Preview]: 1_000_000,
  [Models.google.Gemini_25_Flash_Image]: 1_000_000,
  [Models.google.Gemini_25_Flash_Live]: 1_000_000,
  [Models.google.Gemini_25_Flash_Native_Audio]: 1_000_000,
  [Models.google.Gemini_25_Flash_TTS]: 1_000_000,
  [Models.google.Gemini_25_Pro_TTS]: 1_000_000,
  [Models.google.Gemini_20_Flash]: 1_000_000,
  [Models.google.Gemini_20_Flash_Preview_Image_Generation]: 1_000_000,
  [Models.google.Gemini_20_Flash_Lite]: 1_000_000,
  [Models.google.Gemini_20_Flash_Live]: 1_000_000,
  [Models.google.Gemini_20_Flash_TTS]: 1_000_000,
  [Models.google.Gemini_15_Flash]: 1_000_000,
  [Models.google.Gemini_15_Flash_8B]: 1_000_000,
  [Models.google.Gemini_15_Pro]: 2_000_000,

  // ─── xAI ──────────────────────────────────────────────────────────────────
  [Models.xai.Grok4_1_Fast_Reasoning]: 2_000_000,
  [Models.xai.Grok4_1_Fast_NonReasoning]: 2_000_000,
  [Models.xai.GrokCodeFast]: 2_000_000,
  [Models.xai.Grok4]: 131_072,
  [Models.xai.Grok3Beta]: 131_072,
  [Models.xai.Grok3MiniBeta]: 131_072,
  [Models.xai.Grok3FastBeta]: 131_072,
  [Models.xai.Grok3MiniFastBeta]: 131_072,
  [Models.xai.Grok21212]: 131_072,
  [Models.xai.Grok2Vision1212]: 131_072,
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
