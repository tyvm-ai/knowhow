/**
 * Google model IDs, pricing, and catalog.
 * Single source of truth for all Google/Gemini models.
 */
import { completions, embeddings, images, videos, audios, liveApi, ModelCatalogEntry, ModelPricing } from "./types";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const GoogleModels = {
  // Gemini 3.x
  Gemini_31_Pro_Preview: "gemini-3.1-pro-preview",
  Gemini_31_Flash_Image_Preview: "gemini-3.1-flash-image-preview",
  Gemini_31_Flash_Lite_Preview: "gemini-3.1-flash-lite-preview",
  Gemini_31_Flash_Live_Preview: "gemini-3.1-flash-live-preview",
  Gemini_3_Flash_Preview: "gemini-3-flash-preview",
  Gemini_3_Pro_Image_Preview: "gemini-3-pro-image-preview",
  // Gemini 2.5
  Gemini_25_Pro: "gemini-2.5-pro",
  Gemini_25_Flash: "gemini-2.5-flash",
  Gemini_25_Flash_Lite: "gemini-2.5-flash-lite",
  Gemini_25_Flash_Preview: "gemini-2.5-flash-preview-05-20",
  Gemini_25_Flash_Preview_0417: "gemini-2.5-flash-preview-04-17",
  Gemini_25_Pro_Preview: "gemini-2.5-pro-preview-05-06",
  Gemini_25_Flash_Image: "gemini-2.5-flash-image",
  Gemini_25_Flash_Image_Preview: "gemini-2.5-flash-image-preview",
  Gemini_25_Flash_Live: "gemini-2.5-flash-live-preview",
  Gemini_25_Flash_Native_Audio: "gemini-2.5-flash-native-audio-preview-12-2025",
  Gemini_25_Pro_TTS: "gemini-2.5-pro-preview-tts",
  // Gemini 2.0
  Gemini_20_Flash: "gemini-2.0-flash",
  Gemini_20_Flash_Preview_Image_Generation: "gemini-2.0-flash-exp-image-generation",
  Gemini_20_Flash_Live: "gemini-2.0-flash-live-001",
  // Gemini 1.5 (legacy)
  Gemini_15_Flash: "gemini-1.5-flash",
  Gemini_15_Flash_8B: "gemini-1.5-flash-8b",
  Gemini_15_Pro: "gemini-1.5-pro",
  // Media generation
  Imagen_3: "imagen-4.0-generate-001",
  Imagen_4_Fast: "imagen-4.0-fast-generate-001",
  Imagen_4_Ultra: "imagen-4.0-ultra-generate-001",
  Veo_2: "veo-2.0-generate-001",
  Veo_3: "veo-3.0-generate-001",
  Veo_3_Fast: "veo-3.0-fast-generate-001",
  Veo_3_1: "veo-3.1-generate-preview",
  Veo_3_1_Fast: "veo-3.1-fast-generate-preview",
  // Audio / TTS
  Gemini_25_Flash_TTS: "gemini-2.5-flash-preview-tts",
  Gemini_20_Flash_TTS: "gemini-2.0-flash-preview-tts",
} as const;

// ─── Gemma models (free via Google AI / NVIDIA NIM) ───────────────────────────
export const GemmaModels = {
  Gemma_3_27B_It: "gemma-3-27b-it",
  Gemma_3_12B_It: "gemma-3-12b-it",
  Gemma_3_4B_It: "gemma-3-4b-it",
  Gemma_3n_E2B_It: "gemma-3n-e2b-it",
  Gemma_3n_E4B_It: "gemma-3n-e4b-it",
  Gemma_4_26B_A4B_It: "gemma-4-26b-a4b-it",
  Gemma_4_31B_It: "gemma-4-31b-it",
} as const;

export const GoogleEmbeddingModels: Record<string, string> = {
  Gemini_Embedding: "gemini-embedding-exp",
  Gemini_Embedding_001: "gemini-embedding-001",
};

// ─── Modality arrays ──────────────────────────────────────────────────────────

export const GoogleTextModels: string[] = [
  GoogleModels.Gemini_31_Pro_Preview,
  GoogleModels.Gemini_31_Flash_Lite_Preview,
  GoogleModels.Gemini_25_Pro,
  GoogleModels.Gemini_25_Flash,
  GoogleModels.Gemini_25_Flash_Lite,
  GoogleModels.Gemini_20_Flash,
];

// Models that support thinkingLevel (Gemini 3.x series)
export const GoogleThinkingLevelModels: string[] = [
  GoogleModels.Gemini_31_Pro_Preview,
  GoogleModels.Gemini_31_Flash_Lite_Preview,
  GoogleModels.Gemini_3_Flash_Preview,
];

// Models that support thinkingBudget (Gemini 2.5 series)
export const GoogleThinkingBudgetModels: string[] = [
  GoogleModels.Gemini_25_Pro,
  GoogleModels.Gemini_25_Flash,
  GoogleModels.Gemini_25_Flash_Lite,
  GoogleModels.Gemini_25_Flash_Preview,
  GoogleModels.Gemini_25_Flash_Preview_0417,
  GoogleModels.Gemini_25_Pro_Preview,
];

// Live API only — not compatible with generateContent (text completions)
export const GoogleLiveApiModels: string[] = [
  GoogleModels.Gemini_31_Flash_Live_Preview,
  GoogleModels.Gemini_25_Flash_Live,
  GoogleModels.Gemini_25_Flash_Native_Audio,
  GoogleModels.Gemini_20_Flash_Live,
];

// Limited availability — exist in catalog but return empty or restricted responses
export const GoogleLimitedModels: string[] = [
  GoogleModels.Gemini_3_Flash_Preview,
];

// All deprecated/legacy models — metadata is embedded in GeminiPricing entries
const GoogleAllDeprecatedModels: string[] = [
  // Deprecated previews (shutdownDate + replacedBy in GeminiPricing)
  GoogleModels.Gemini_25_Flash_Preview,
  GoogleModels.Gemini_25_Flash_Preview_0417,
  GoogleModels.Gemini_25_Pro_Preview,
  // Legacy (Gemini 1.5 — returning 404)
  GoogleModels.Gemini_15_Flash,
  GoogleModels.Gemini_15_Flash_8B,
  GoogleModels.Gemini_15_Pro,
];

export const GemmaTextModels: string[] = [
  GemmaModels.Gemma_3_27B_It,
  GemmaModels.Gemma_3_12B_It,
  GemmaModels.Gemma_3_4B_It,
  GemmaModels.Gemma_3n_E2B_It,
  GemmaModels.Gemma_3n_E4B_It,
  GemmaModels.Gemma_4_26B_A4B_It,
  GemmaModels.Gemma_4_31B_It,
];

export const GoogleImageModels: string[] = [
  GoogleModels.Gemini_31_Flash_Image_Preview,
  GoogleModels.Gemini_3_Pro_Image_Preview,
  GoogleModels.Gemini_25_Flash_Image,
  GoogleModels.Gemini_25_Flash_Image_Preview,
  GoogleModels.Gemini_20_Flash_Preview_Image_Generation,
  GoogleModels.Imagen_3,
  GoogleModels.Imagen_4_Fast,
  GoogleModels.Imagen_4_Ultra,
];

export const GoogleVideoModels: string[] = [
  GoogleModels.Veo_2,
  GoogleModels.Veo_3,
  GoogleModels.Veo_3_Fast,
  GoogleModels.Veo_3_1,
  GoogleModels.Veo_3_1_Fast,
];

export const GoogleTTSModels: string[] = [
  GoogleModels.Gemini_25_Flash_TTS,
  GoogleModels.Gemini_25_Pro_TTS,
  GoogleModels.Gemini_20_Flash_TTS,
];

export const GoogleEmbeddingModelsList: string[] = [
  GoogleEmbeddingModels.Gemini_Embedding,
  GoogleEmbeddingModels.Gemini_Embedding_001,
];

// ─── Pricing ──────────────────────────────────────────────────────────────────

export interface GeminiModelPricing extends ModelPricing {
  input_audio?: number;
  input_gt_200k?: number;
  output_gt_200k?: number;
  context_caching?: number;
  context_caching_audio?: number;
  context_caching_gt_200k?: number;
  context_caching_storage?: number;
  thinking_output?: number;
}

export const GeminiPricing: Record<string, GeminiModelPricing> = {
  [GoogleModels.Gemini_31_Pro_Preview]: {
    input: 2, input_gt_200k: 4, output: 12, output_gt_200k: 18,
    context_caching: 0.2, context_caching_gt_200k: 0.4, context_caching_storage: 4.5,
  },
  [GoogleModels.Gemini_31_Flash_Image_Preview]: {
    input: 0.25, output: 60.0, image_generation: 0.045, image_generation_per_1m_tokens: 60.0,
  },
  [GoogleModels.Gemini_31_Flash_Lite_Preview]: {
    input: 0.25, input_audio: 0.5, output: 1.5,
    context_caching: 0.025, context_caching_audio: 0.05, context_caching_storage: 1.0,
  },
  [GoogleModels.Gemini_31_Flash_Live_Preview]: {
    input: 0.75, input_audio: 3.0, output: 4.5, output_audio: 12.0,
  },
  [GoogleModels.Gemini_3_Flash_Preview]: {
    input: 0.5, input_audio: 1.0, output: 3.0,
    context_caching: 0.05, context_caching_audio: 0.10, context_caching_storage: 1.0,
    limitedAvailability: true,
  },
  [GoogleModels.Gemini_3_Pro_Image_Preview]: {
    input: 2, output: 12, image_generation: 0.134,
  },
  [GoogleModels.Gemini_25_Pro]: {
    input: 1.25, input_gt_200k: 2.5, output: 10.0, output_gt_200k: 15.0,
    context_caching: 0.125, context_caching_gt_200k: 0.25, context_caching_storage: 4.5,
  },
  [GoogleModels.Gemini_25_Flash]: {
    input: 0.3, input_audio: 1.0, output: 2.5,
    context_caching: 0.03, context_caching_audio: 0.1, context_caching_storage: 1.0,
  },
  [GoogleModels.Gemini_25_Flash_Lite]: {
    input: 0.1, input_audio: 0.3, output: 0.4,
    context_caching: 0.01, context_caching_audio: 0.03, context_caching_storage: 1.0,
  },
  [GoogleModels.Gemini_25_Flash_Preview_0417]: { input: 0.15, output: 0.60, context_caching: 0.0375, deprecated: true, deprecationDate: "2025-11-18", replacedBy: GoogleModels.Gemini_3_Flash_Preview },
  [GoogleModels.Gemini_25_Flash_Preview]: {
    input: 0.15, input_audio: 0.5, output: 0.60, context_caching: 0.0375, deprecated: true, deprecationDate: "2025-11-18", replacedBy: GoogleModels.Gemini_3_Flash_Preview,
  },
  [GoogleModels.Gemini_25_Pro_Preview]: {
    input: 1.25, input_gt_200k: 2.5, output: 10.0, output_gt_200k: 15.0,
    context_caching: 0.125, context_caching_gt_200k: 0.25, context_caching_storage: 4.5,
    deprecated: true, deprecationDate: "2025-12-02", replacedBy: GoogleModels.Gemini_31_Pro_Preview,
  },
  [GoogleModels.Gemini_25_Flash_Image]: {
    input: 0.3, output: 30.0, image_generation: 0.039, image_generation_per_1m_tokens: 30.0,
  },
  [GoogleModels.Gemini_25_Flash_Image_Preview]: {
    input: 0.3, output: 30.0, image_generation: 0.039, image_generation_per_1m_tokens: 30.0,
  },
  [GoogleModels.Gemini_25_Flash_Live]: { input: 0.5, input_audio: 3.0, output: 2.0, output_audio: 12.0 },
  [GoogleModels.Gemini_25_Flash_Native_Audio]: { input: 0.5, input_audio: 3.0, output: 2.0, output_audio: 12.0 },
  [GoogleModels.Gemini_25_Flash_TTS]: { input: 0.5, output_audio: 10.0, output: 10.0 },
  [GoogleModels.Gemini_25_Pro_TTS]: { input: 1.0, output_audio: 20.0, output: 20.0 },
  [GoogleModels.Gemini_20_Flash_TTS]: { input: 0.1, output_audio: 4.0, output: 4.0 },
  [GoogleModels.Gemini_20_Flash]: {
    input: 0.1, input_audio: 0.7, output: 0.4,
    context_caching: 0.025, context_caching_audio: 0.175, context_caching_storage: 1.0,
  },
  [GoogleModels.Gemini_20_Flash_Preview_Image_Generation]: { input: 0.1, output: 0.4, image_generation: 0.039 },
  [GoogleModels.Gemini_20_Flash_Live]: { input: 0.1, output: 0.4 },
  [GoogleModels.Gemini_15_Flash]:   { input: 0.075, output: 0.3,  context_caching: 0.01875, deprecated: true },
  [GoogleModels.Gemini_15_Flash_8B]:{ input: 0.0375, output: 0.15, context_caching: 0.01,   deprecated: true },
  [GoogleModels.Gemini_15_Pro]:     { input: 1.25, output: 5.0,   context_caching: 0.3125,  deprecated: true },
  [GoogleModels.Imagen_3]: { image_generation: 0.04 },
  [GoogleModels.Imagen_4_Fast]: { image_generation: 0.02 },
  [GoogleModels.Imagen_4_Ultra]: { image_generation: 0.06 },
  [GoogleModels.Veo_2]: { video_generation: 0.35 },
  [GoogleModels.Veo_3]: { video_generation: 0.4 },
  [GoogleModels.Veo_3_Fast]: { video_generation: 0.1 },
  [GoogleModels.Veo_3_1]: { video_generation: 0.4 },
  [GoogleModels.Veo_3_1_Fast]: { video_generation: 0.1 },
  [GoogleEmbeddingModels.Gemini_Embedding]: { input: 0 },
  [GoogleEmbeddingModels.Gemini_Embedding_001]: { input: 0.15 },
};

// ─── Gemma pricing (free via Google AI) ──────────────────────────────────────
export const GemmaPricing: Record<string, GeminiModelPricing> = {
  [GemmaModels.Gemma_3_27B_It]: { input: 0.0, output: 0.0 },
  [GemmaModels.Gemma_3_12B_It]: { input: 0.0, output: 0.0 },
  [GemmaModels.Gemma_3_4B_It]: { input: 0.0, output: 0.0 },
  [GemmaModels.Gemma_3n_E2B_It]: { input: 0.0, output: 0.0 },
  [GemmaModels.Gemma_3n_E4B_It]: { input: 0.0, output: 0.0 },
  [GemmaModels.Gemma_4_26B_A4B_It]: { input: 0.0, output: 0.0 },
  [GemmaModels.Gemma_4_31B_It]: { input: 0.0, output: 0.0 },
};

/** @deprecated Use GeminiPricing instead. */
export const GeminiTextPricing = GeminiPricing;

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Metadata (deprecated, deprecationDate, limitedAvailability, replacedBy) is
// read directly from the GeminiPricing entries — no need for separate groups.

export const GOOGLE_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...completions([...GoogleTextModels, ...GoogleLimitedModels, ...GoogleAllDeprecatedModels], "google", GeminiPricing),
  ...liveApi(GoogleLiveApiModels,      "google", GeminiPricing),
  ...embeddings(GoogleEmbeddingModelsList, "google", GeminiPricing),
  ...images(GoogleImageModels,         "google", GeminiPricing),
  ...videos(GoogleVideoModels,         "google", GeminiPricing),
  ...completions(GemmaTextModels,      "google", GemmaPricing),
  ...audios(GoogleTTSModels,           "google", GeminiPricing),
];
