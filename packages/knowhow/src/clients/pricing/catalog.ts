/**
 * Model catalog: a single source of truth for all supported AI models,
 * their providers, types, display names, and pricing.
 *
 * Pricing is in USD per 1M tokens (or per-image / per-second for media models).
 * This is exported so the Knowhow backend (and other consumers) can import
 * model/pricing data without duplicating it.
 */

import { Models, EmbeddingModels } from "../../types";
import { OpenAiTextPricing } from "./openai";
import { AnthropicTextPricing } from "./anthropic";
import { GeminiPricing } from "./google";
import { XaiTextPricing, XaiImagePricing, XaiVideoPricing } from "./xai";

export type ModelType =
  | "completion"
  | "embedding"
  | "image"
  | "audio"
  | "video"
  | "transaction";

export interface ModelPricing {
  input: number;
  output: number;
  cached_input?: number;
  cache_write?: number;
  cache_hit?: number;
  input_audio?: number;
  output_audio?: number;
  input_gt_200k?: number;
  output_gt_200k?: number;
  image_generation?: number;
  video_generation?: number;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  type: ModelType;
  displayName: string;
  pricing: ModelPricing;
  /** Markup applied on top of base pricing (as a fraction, e.g. 0.025 = 2.5%) */
  markupPercent: number;
}

// ─── Platform markup ──────────────────────────────────────────────────────────

/** 2.5% platform markup applied on top of all provider base rates */
export const USAGE_MARKUP_PERCENT = 2.5 / 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function completion(
  id: string,
  provider: string,
  displayName: string,
  pricingOverride?: Partial<ModelPricing>
): ModelCatalogEntry {
  const base =
    (OpenAiTextPricing as Record<string, Partial<ModelPricing>>)[id] ||
    (AnthropicTextPricing as Record<string, Partial<ModelPricing>>)[id] ||
    (GeminiPricing as Record<string, Partial<ModelPricing>>)[id] ||
    (XaiTextPricing as Record<string, Partial<ModelPricing>>)[id] ||
    {};
  return {
    id,
    provider,
    type: "completion",
    displayName,
    markupPercent: USAGE_MARKUP_PERCENT,
    pricing: {
      input: 0,
      output: 0,
      ...base,
      ...pricingOverride,
    },
  };
}

function embedding(
  id: string,
  provider: string,
  displayName: string,
  input: number
): ModelCatalogEntry {
  return {
    id,
    provider,
    type: "embedding",
    displayName,
    markupPercent: USAGE_MARKUP_PERCENT,
    pricing: { input, output: 0 },
  };
}

function image(
  id: string,
  provider: string,
  displayName: string,
  pricing: Partial<ModelPricing>
): ModelCatalogEntry {
  return {
    id,
    provider,
    type: "image",
    displayName,
    markupPercent: USAGE_MARKUP_PERCENT,
    pricing: { input: 0, output: 0, ...pricing },
  };
}

function video(
  id: string,
  provider: string,
  displayName: string,
  video_generation: number
): ModelCatalogEntry {
  return {
    id,
    provider,
    type: "video",
    displayName,
    markupPercent: USAGE_MARKUP_PERCENT,
    pricing: { input: 0, output: 0, video_generation },
  };
}

function audio(
  id: string,
  provider: string,
  displayName: string,
  pricing: Partial<ModelPricing>
): ModelCatalogEntry {
  return {
    id,
    provider,
    type: "audio",
    displayName,
    markupPercent: USAGE_MARKUP_PERCENT,
    pricing: { input: 0, output: 0, ...pricing },
  };
}

function transaction(
  id: string,
  provider: string,
  displayName: string,
  pricing: Partial<ModelPricing>
): ModelCatalogEntry {
  return {
    id,
    provider,
    type: "transaction",
    displayName,
    markupPercent: USAGE_MARKUP_PERCENT,
    pricing: { input: 0, output: 0, ...pricing },
  };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

export const OPENAI_MODEL_CATALOG: ModelCatalogEntry[] = [
  // Completion
  completion(Models.openai.GPT_4o, "openai", "GPT-4o"),
  completion(Models.openai.GPT_4o_Mini, "openai", "GPT-4o Mini"),
  completion(Models.openai.GPT_41, "openai", "GPT-4.1"),
  completion(Models.openai.GPT_41_Mini, "openai", "GPT-4.1 Mini"),
  completion(Models.openai.GPT_41_Nano, "openai", "GPT-4.1 Nano"),
  completion(Models.openai.GPT_45, "openai", "GPT-4.5 Preview"),
  completion(Models.openai.o1, "openai", "o1"),
  completion(Models.openai.o1_Mini, "openai", "o1 Mini"),
  completion(Models.openai.o3, "openai", "o3"),
  completion(Models.openai.o3_Mini, "openai", "o3 Mini"),
  completion(Models.openai.o4_Mini, "openai", "o4 Mini"),
  // Embedding
  embedding(EmbeddingModels.openai.EmbeddingAda2, "openai", "Embedding Ada 002", OpenAiTextPricing[EmbeddingModels.openai.EmbeddingAda2]?.input ?? 0.1),
  embedding(EmbeddingModels.openai.EmbeddingLarge3, "openai", "Embedding 3 Large", OpenAiTextPricing[EmbeddingModels.openai.EmbeddingLarge3]?.input ?? 0.13),
  embedding(EmbeddingModels.openai.EmbeddingSmall3, "openai", "Embedding 3 Small", OpenAiTextPricing[EmbeddingModels.openai.EmbeddingSmall3]?.input ?? 0.02),
  // Image generation
  image(Models.openai.DALL_E_3, "openai", "DALL-E 3", { image_generation: 0.04 }),
  image(Models.openai.DALL_E_2, "openai", "DALL-E 2", { image_generation: 0.02 }),
  image(Models.openai.GPT_Image_15, "openai", "GPT Image 1.5", { input: OpenAiTextPricing[Models.openai.GPT_Image_15]?.input ?? 5.0, output: OpenAiTextPricing[Models.openai.GPT_Image_15]?.output ?? 10.0 }),
  image(Models.openai.GPT_Image_1_Mini, "openai", "GPT Image 1 Mini", { input: OpenAiTextPricing[Models.openai.GPT_Image_1_Mini]?.input ?? 2.0 }),
  // Video generation
  video(Models.openai.Sora, "openai", "Sora", 0.012),
  video(Models.openai.Sora_2, "openai", "Sora 2", 0.015),
  // Audio
  audio(Models.openai.TTS_1, "openai", "TTS-1", { input: 15.0 }),
  audio(Models.openai.Whisper_1, "openai", "Whisper 1", { input: 0.006 }),
  // Transaction / Search
  transaction(Models.openai.GPT_4o_Mini_Search, "openai", "GPT-4o Mini Search", { input: OpenAiTextPricing[Models.openai.GPT_4o_Mini_Search]?.input ?? 0.15, output: OpenAiTextPricing[Models.openai.GPT_4o_Mini_Search]?.output ?? 0.6 }),
  transaction(Models.openai.GPT_4o_Search, "openai", "GPT-4o Search", { input: OpenAiTextPricing[Models.openai.GPT_4o_Search]?.input ?? 2.5, output: OpenAiTextPricing[Models.openai.GPT_4o_Search]?.output ?? 10.0 }),
];

// ─── Anthropic ────────────────────────────────────────────────────────────────

export const ANTHROPIC_MODEL_CATALOG: ModelCatalogEntry[] = [
  completion(Models.anthropic.Opus4_5, "anthropic", "Claude Opus 4.5"),
  completion(Models.anthropic.Sonnet4_5, "anthropic", "Claude Sonnet 4.5"),
  completion(Models.anthropic.Opus4, "anthropic", "Claude Opus 4"),
  completion(Models.anthropic.Sonnet4, "anthropic", "Claude Sonnet 4"),
  completion(Models.anthropic.Haiku4_5, "anthropic", "Claude Haiku 4.5"),
  completion(Models.anthropic.Sonnet3_7, "anthropic", "Claude Sonnet 3.7"),
  completion(Models.anthropic.Sonnet3_5, "anthropic", "Claude Sonnet 3.5"),
  completion(Models.anthropic.Haiku3, "anthropic", "Claude Haiku 3"),
  completion(Models.anthropic.Opus3, "anthropic", "Claude Opus 3"),
];

// ─── Google ───────────────────────────────────────────────────────────────────

export const GOOGLE_MODEL_CATALOG: ModelCatalogEntry[] = [
  // Completion
  completion(Models.google.Gemini_25_Pro, "google", "Gemini 2.5 Pro"),
  completion(Models.google.Gemini_25_Flash, "google", "Gemini 2.5 Flash"),
  completion(Models.google.Gemini_25_Flash_Lite, "google", "Gemini 2.5 Flash Lite"),
  completion(Models.google.Gemini_20_Flash, "google", "Gemini 2.0 Flash"),
  completion(Models.google.Gemini_15_Pro, "google", "Gemini 1.5 Pro"),
  completion(Models.google.Gemini_15_Flash, "google", "Gemini 1.5 Flash"),
  completion(Models.google.Gemini_15_Flash_8B, "google", "Gemini 1.5 Flash 8B"),
  // Embedding
  embedding(EmbeddingModels.google.Gemini_Embedding, "google", "Gemini Embedding", GeminiPricing[EmbeddingModels.google.Gemini_Embedding]?.input ?? 0),
  // Image generation
  image(Models.google.Gemini_20_Flash_Preview_Image_Generation, "google", "Gemini 2.0 Flash Image", {
    input: GeminiPricing[Models.google.Gemini_20_Flash_Preview_Image_Generation]?.input ?? 0.1,
    output: GeminiPricing[Models.google.Gemini_20_Flash_Preview_Image_Generation]?.output ?? 0.4,
    image_generation: GeminiPricing[Models.google.Gemini_20_Flash_Preview_Image_Generation]?.image_generation ?? 0.039,
  }),
  image(Models.google.Gemini_25_Flash_Image, "google", "Gemini 2.5 Flash Image", {
    input: GeminiPricing[Models.google.Gemini_25_Flash_Image]?.input ?? 0.3,
    output: GeminiPricing[Models.google.Gemini_25_Flash_Image]?.output ?? 0.039,
    image_generation: GeminiPricing[Models.google.Gemini_25_Flash_Image]?.image_generation ?? 0.039,
  }),
  image(Models.google.Gemini_31_Flash_Image_Preview, "google", "Gemini 3.1 Flash Image", {
    input: GeminiPricing[Models.google.Gemini_31_Flash_Image_Preview]?.input ?? 0.5,
    output: GeminiPricing[Models.google.Gemini_31_Flash_Image_Preview]?.output ?? 3.0,
    image_generation: GeminiPricing[Models.google.Gemini_31_Flash_Image_Preview]?.image_generation ?? 0.045,
  }),
  image(Models.google.Gemini_3_Pro_Image_Preview, "google", "Gemini 3 Pro Image", {
    input: GeminiPricing[Models.google.Gemini_3_Pro_Image_Preview]?.input ?? 2.0,
    output: GeminiPricing[Models.google.Gemini_3_Pro_Image_Preview]?.output ?? 12.0,
    image_generation: GeminiPricing[Models.google.Gemini_3_Pro_Image_Preview]?.image_generation ?? 0.134,
  }),
  image(Models.google.Imagen_3, "google", "Imagen 4", { image_generation: GeminiPricing[Models.google.Imagen_3]?.image_generation ?? 0.04 }),
  image(Models.google.Imagen_4_Fast, "google", "Imagen 4 Fast", { image_generation: GeminiPricing[Models.google.Imagen_4_Fast]?.image_generation ?? 0.02 }),
  image(Models.google.Imagen_4_Ultra, "google", "Imagen 4 Ultra", { image_generation: GeminiPricing[Models.google.Imagen_4_Ultra]?.image_generation ?? 0.06 }),
  // Video generation
  video(Models.google.Veo_2, "google", "Veo 2", GeminiPricing[Models.google.Veo_2]?.video_generation ?? 0.35),
  video(Models.google.Veo_3, "google", "Veo 3", GeminiPricing[Models.google.Veo_3]?.video_generation ?? 0.4),
  video(Models.google.Veo_3_Fast, "google", "Veo 3 Fast", GeminiPricing[Models.google.Veo_3_Fast]?.video_generation ?? 0.1),
  // Audio (TTS)
  audio(Models.google.Gemini_25_Flash_TTS, "google", "Gemini 2.5 Flash TTS", {
    input: GeminiPricing[Models.google.Gemini_25_Flash_TTS]?.input ?? 0.5,
    output_audio: GeminiPricing[Models.google.Gemini_25_Flash_TTS]?.output_audio ?? 10.0,
    output: GeminiPricing[Models.google.Gemini_25_Flash_TTS]?.output_audio ?? 10.0,
  }),
  audio(Models.google.Gemini_25_Pro_TTS, "google", "Gemini 2.5 Pro TTS", {
    input: GeminiPricing[Models.google.Gemini_25_Pro_TTS]?.input ?? 1.0,
    output_audio: GeminiPricing[Models.google.Gemini_25_Pro_TTS]?.output_audio ?? 20.0,
    output: GeminiPricing[Models.google.Gemini_25_Pro_TTS]?.output_audio ?? 20.0,
  }),
];

// ─── xAI ──────────────────────────────────────────────────────────────────────

export const XAI_MODEL_CATALOG: ModelCatalogEntry[] = [
  completion(Models.xai.Grok4, "xai", "Grok 4"),
  completion(Models.xai.Grok3Beta, "xai", "Grok 3 Beta"),
  completion(Models.xai.Grok3MiniBeta, "xai", "Grok 3 Mini Beta"),
  completion(Models.xai.Grok3FastBeta, "xai", "Grok 3 Fast Beta"),
  completion(Models.xai.Grok21212, "xai", "Grok 2"),
  // Image generation
  image(Models.xai.GrokImagineImage, "xai", "Grok Imagine Image", { image_generation: XaiImagePricing["grok-imagine-image"] ?? 0.02 }),
  image("grok-2-image-1212", "xai", "Grok 2 Image", { image_generation: XaiImagePricing["grok-2-image-1212"] ?? 0.07 }),
  // Video generation
  video(Models.xai.GrokImagineVideo, "xai", "Grok Imagine Video", XaiVideoPricing["grok-imagine-video"] ?? 0.05),
];

// ─── Combined catalog ─────────────────────────────────────────────────────────

export const ALL_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...OPENAI_MODEL_CATALOG,
  ...ANTHROPIC_MODEL_CATALOG,
  ...GOOGLE_MODEL_CATALOG,
  ...XAI_MODEL_CATALOG,
];
