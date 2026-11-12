/**
 * Google model IDs, pricing, and catalog.
 * Single source of truth for all Google/Gemini models.
 */
import { completions, embeddings, images, videos, audios, decisions, liveApi, ModelCatalogEntry, ModelPricing } from "./types";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const GoogleModels = {
  // Gemini 4
  Gemini_4_Carbon: "gemini-4-carbon",
  Gemini_4_Argon: "gemini-4-argon",
  // Decisions API (calibrated noul/choice/score answers, zero output tokens)
  Gemini_Decision_1: "gemini-decision-1",
  // Gemini 3.8 / 3.7 / 3.6 / 3.5
  Gemini_38_Flash: "gemini-3.8-flash",
  Gemini_37_Flash: "gemini-3.7-flash",
  Gemini_36_Flash: "gemini-3.6-flash",
  Gemini_35_Flash: "gemini-3.5-flash",
  Gemini_35_Flash_Lite: "gemini-3.5-flash-lite",
  Gemini_35_Live_Translate_Preview: "gemini-3.5-live-translate-preview",
  // Gemini 3.x
  Gemini_31_Pro_Preview: "gemini-3.1-pro-preview",
  Gemini_31_Flash_Lite: "gemini-3.1-flash-lite",
  Gemini_31_Flash_Image: "gemini-3.1-flash-image",
  Gemini_31_Flash_Image_Preview: "gemini-3.1-flash-image-preview",
  Gemini_31_Flash_Lite_Image: "gemini-3.1-flash-lite-image",
  Gemini_31_Flash_Lite_Preview: "gemini-3.1-flash-lite-preview",
  Gemini_31_Flash_Live_Preview: "gemini-3.1-flash-live-preview",
  Gemini_31_Flash_TTS_Preview: "gemini-3.1-flash-tts-preview",
  Gemini_3_Pro_Preview: "gemini-3-pro-preview",
  Gemini_3_Flash_Preview: "gemini-3-flash-preview",
  Gemini_3_Pro_Image: "gemini-3-pro-image",
  Gemini_3_Pro_Image_Preview: "gemini-3-pro-image-preview",
  Gemini_Nano_Banana_21: "gemini-nano-banana-2.1",
  Gemini_Omni_Flash_Preview: "gemini-omni-flash-preview",
  // Gemini Omni (video generation + editing, Interactions API only)
  Gemini_Omni_12_Flash: "gemini-omni-1.2-flash",
  Gemini_Omni_11_Flash: "gemini-omni-1.1-flash",
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
  Gemini_25_Computer_Use_Preview: "gemini-2.5-computer-use-preview-10-2025",
  // Gemini 2.0
  Gemini_20_Flash: "gemini-2.0-flash",
  Gemini_20_Flash_Preview_Image_Generation: "gemini-2.0-flash-exp-image-generation",
  Gemini_20_Flash_Lite: "gemini-2.0-flash-lite",
  Gemini_20_Flash_Live: "gemini-2.0-flash-live-001",
  // Robotics
  Gemini_Robotics_ER_16_Preview: "gemini-robotics-er-1.6-preview",
  Gemini_Robotics_ER_15_Preview: "gemini-robotics-er-1.5-preview",
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
  Veo_3_1_Lite: "veo-3.1-lite-generate-preview",
  // Music generation (Lyria, Interactions API only)
  Lyria_35: "lyria-3.5",
  Lyria_3_Clip_Preview: "lyria-3-clip-preview",
  Lyria_3_Pro_Preview: "lyria-3-pro-preview",
  // Audio / TTS
  Gemini_38_Flash_TTS: "gemini-3.8-flash-tts",
  Gemini_38_Flash_Lite_TTS: "gemini-3.8-flash-lite-tts",
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
  Gemini_Embedding_2: "gemini-embedding-2",
};

// ─── Modality arrays ──────────────────────────────────────────────────────────

export const GoogleTextModels: string[] = [
  GoogleModels.Gemini_4_Carbon,
  GoogleModels.Gemini_4_Argon,
  GoogleModels.Gemini_38_Flash,
  GoogleModels.Gemini_36_Flash,
  GoogleModels.Gemini_35_Flash_Lite,
  GoogleModels.Gemini_31_Pro_Preview,
  GoogleModels.Gemini_31_Flash_Lite,
  GoogleModels.Gemini_31_Flash_Lite_Preview,
  GoogleModels.Gemini_Robotics_ER_16_Preview,
  GoogleModels.Gemini_25_Flash_Lite,
  GoogleModels.Gemini_20_Flash,
  // Deprecated but still served — Google reroutes these endpoints (see
  // routesTo in GeminiPricing). Kept registered so existing configs keep
  // working; AIClient sends requests straight to the replacement.
  GoogleModels.Gemini_37_Flash,      // → gemini-3.8-flash (now)
  GoogleModels.Gemini_35_Flash,      // → gemini-3.6-flash (now)
  GoogleModels.Gemini_25_Pro,        // → gemini-3.8-flash (from 2026-12-01)
  GoogleModels.Gemini_25_Flash,      // → gemini-3.5-flash-lite (from 2026-12-01)
];

// Models that support thinkingLevel (Gemini 3.x series)
export const GoogleThinkingLevelModels: string[] = [
  GoogleModels.Gemini_4_Carbon,
  GoogleModels.Gemini_4_Argon,
  GoogleModels.Gemini_38_Flash,
  GoogleModels.Gemini_37_Flash,
  GoogleModels.Gemini_36_Flash,
  GoogleModels.Gemini_35_Flash,
  GoogleModels.Gemini_35_Flash_Lite,
  GoogleModels.Gemini_31_Pro_Preview,
  GoogleModels.Gemini_31_Flash_Lite,
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
  GoogleModels.Gemini_35_Live_Translate_Preview,
  GoogleModels.Gemini_25_Flash_Live,
  GoogleModels.Gemini_25_Flash_Native_Audio,
  GoogleModels.Gemini_20_Flash_Live,
];

// Limited availability — exist in catalog but return empty or restricted responses
export const GoogleLimitedModels: string[] = [
  GoogleModels.Gemini_3_Flash_Preview,
  // Only usable via the Interactions API — not compatible with generateContent
  GoogleModels.Gemini_Omni_Flash_Preview,
  // Requires the Computer Use tool to be attached — not a plain text model
  GoogleModels.Gemini_25_Computer_Use_Preview,
];

// All deprecated/legacy models — metadata is embedded in GeminiPricing entries
const GoogleAllDeprecatedModels: string[] = [
  // Deprecated previews (shutdownDate + replacedBy in GeminiPricing)
  GoogleModels.Gemini_25_Flash_Preview,
  GoogleModels.Gemini_25_Flash_Preview_0417,
  GoogleModels.Gemini_25_Pro_Preview,
  // Deprecated/removed previews (returning 404 — replaced by newer models)
  GoogleModels.Gemini_3_Pro_Preview,
  GoogleModels.Gemini_Robotics_ER_15_Preview,
  // Legacy (Gemini 1.5 — returning 404)
  GoogleModels.Gemini_15_Flash,
  GoogleModels.Gemini_15_Flash_8B,
  GoogleModels.Gemini_15_Pro,
  GoogleModels.Gemini_20_Flash_Lite,
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
  GoogleModels.Gemini_Nano_Banana_21,
  GoogleModels.Gemini_31_Flash_Image,
  GoogleModels.Gemini_31_Flash_Image_Preview,
  GoogleModels.Gemini_31_Flash_Lite_Image,
  GoogleModels.Gemini_3_Pro_Image,
  GoogleModels.Gemini_3_Pro_Image_Preview,
  GoogleModels.Gemini_25_Flash_Image,
  GoogleModels.Gemini_25_Flash_Image_Preview,
  GoogleModels.Gemini_20_Flash_Preview_Image_Generation,
  GoogleModels.Imagen_3,
  GoogleModels.Imagen_4_Fast,
  GoogleModels.Imagen_4_Ultra,
];

export const GoogleVideoModels: string[] = [
  // Interactions API (POST /v1beta/interactions) — the only video models the
  // Gemini API still serves.
  GoogleModels.Gemini_Omni_12_Flash,
  GoogleModels.Gemini_Omni_11_Flash, // → gemini-omni-1.2-flash (from 2026-12-03)
  // Shut down in the Gemini API (404) — kept registered for existing configs.
  GoogleModels.Veo_2,
  GoogleModels.Veo_3,
  GoogleModels.Veo_3_Fast,
  GoogleModels.Veo_3_1,
  GoogleModels.Veo_3_1_Fast,
  GoogleModels.Veo_3_1_Lite,
];

// Music generation via the Interactions API (Lyria). Registered under the
// "audio" modality alongside TTS; createAudioGeneration routes by model id.
export const GoogleMusicModels: string[] = [
  GoogleModels.Lyria_35,
  GoogleModels.Lyria_3_Clip_Preview,
  GoogleModels.Lyria_3_Pro_Preview,
];

/** Models served only by the Interactions API (POST /v1beta/interactions). */
export const GoogleInteractionsModels: string[] = [
  GoogleModels.Gemini_Omni_12_Flash,
  GoogleModels.Gemini_Omni_11_Flash,
  ...GoogleMusicModels,
];

export const GoogleTTSModels: string[] = [
  GoogleModels.Gemini_38_Flash_TTS,
  GoogleModels.Gemini_38_Flash_Lite_TTS,
  GoogleModels.Gemini_31_Flash_TTS_Preview,
  GoogleModels.Gemini_25_Flash_TTS,
  GoogleModels.Gemini_25_Pro_TTS,
  GoogleModels.Gemini_20_Flash_TTS,
];

// Decisions API only (POST /v1beta/decisions) — not compatible with generateContent
export const GoogleDecisionModels: string[] = [
  GoogleModels.Gemini_Decision_1,
];

export const GoogleEmbeddingModelsList: string[] = [
  GoogleEmbeddingModels.Gemini_Embedding,
  GoogleEmbeddingModels.Gemini_Embedding_001,
  GoogleEmbeddingModels.Gemini_Embedding_2,
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
  // ── Gemini 4 ──────────────────────────────────────────────────────────────
  // Same introductory pricing as Argon through November 30, 2026. Standard
  // pricing beginning December 1, 2026 is $4.00 input, $20.00 output, and
  // $0.20 cached input. Paid tier only; implicit caching only.
  [GoogleModels.Gemini_4_Carbon]: {
    input: 2.0, output: 10.0,
    context_caching: 0.1,
  },
  // Introductory pricing through November 30, 2026. Standard pricing beginning
  // December 1, 2026 is $4.00 input, $20.00 output, and $0.20 cached input.
  // Implicit caching only (explicit caching is not supported).
  [GoogleModels.Gemini_4_Argon]: {
    input: 2.0, output: 10.0,
    context_caching: 0.1,
  },
  // ── Gemini Decision ───────────────────────────────────────────────────────
  // Decisions API: shared input billed once per request regardless of question
  // count; always 0 output tokens. No caching / batch support.
  [GoogleModels.Gemini_Decision_1]: {
    input: 0.1, output: 0,
  },
  // ── Gemini 3.8 / 3.7 / 3.6 / 3.5 ──────────────────────────────────────────
  // Introductory pricing through December 31, 2026. Standard pricing beginning
  // January 1, 2027 is $1.50 input, $7.50 output, and $0.15 cached input.
  [GoogleModels.Gemini_38_Flash]: {
    input: 0.75, output: 3.75,
    context_caching: 0.075, context_caching_storage: 0.5,
  },
  // Deprecated: the endpoint stays up but Google routes every request to
  // gemini-3.8-flash (billed at 3.8 Flash rates, which match the above).
  [GoogleModels.Gemini_37_Flash]: {
    input: 0.75, output: 3.75,
    context_caching: 0.075, context_caching_storage: 0.5,
    deprecated: true,
    replacedBy: GoogleModels.Gemini_38_Flash,
    routesTo: GoogleModels.Gemini_38_Flash,
  },
  [GoogleModels.Gemini_36_Flash]: {
    input: 1.5, output: 7.5,
    context_caching: 0.15, context_caching_storage: 1.0,
  },
  // Deprecated: the endpoint stays up but Google routes every request to
  // gemini-3.6-flash (billed at 3.6 Flash rates).
  [GoogleModels.Gemini_35_Flash]: {
    input: 1.5, output: 9.0,
    context_caching: 0.15, context_caching_storage: 1.0,
    deprecated: true,
    replacedBy: GoogleModels.Gemini_36_Flash,
    routesTo: GoogleModels.Gemini_36_Flash,
  },
  [GoogleModels.Gemini_35_Flash_Lite]: {
    input: 0.3, output: 2.5,
    context_caching: 0.03, context_caching_storage: 1.0,
  },
  [GoogleModels.Gemini_35_Live_Translate_Preview]: {
    input: 0, input_audio: 3.5, output: 0, output_audio: 21.0,
  },
  // ── Gemini 3.1 (GA + variants) ────────────────────────────────────────────
  [GoogleModels.Gemini_31_Flash_Lite]: {
    input: 0.25, input_audio: 0.5, output: 1.5,
    context_caching: 0.025, context_caching_audio: 0.05, context_caching_storage: 1.0,
  },
  // Nano Banana 2 — superseded (still served) by Nano Banana 2.1.
  [GoogleModels.Gemini_31_Flash_Image]: {
    input: 0.5, output: 60.0, image_generation: 0.067, image_generation_per_1m_tokens: 60.0,
    replacedBy: GoogleModels.Gemini_Nano_Banana_21,
  },
  [GoogleModels.Gemini_31_Flash_Lite_Image]: {
    input: 0.25, output: 30.0, image_generation: 0.0336, image_generation_per_1m_tokens: 30.0,
  },
  // Introductory pricing through December 31, 2026. Standard pricing beginning
  // January 1, 2027 doubles: $1.00 text input, $18.00 / $12.00 audio output.
  [GoogleModels.Gemini_38_Flash_TTS]: {
    input: 0.5, output_audio: 9.0, output: 9.0,
  },
  [GoogleModels.Gemini_38_Flash_Lite_TTS]: {
    input: 0.5, output_audio: 6.0, output: 6.0,
  },
  // Nano Banana 2.1: $7.50 text/thinking output, $30 / 1M image output tokens
  // ($0.0336 per 1K image, $0.0504 per 2K image, $0.113 per 4K image).
  [GoogleModels.Gemini_Nano_Banana_21]: {
    input: 1.5, output: 7.5, image_generation: 0.0336, image_generation_per_1m_tokens: 30.0,
  },
  // Preview superseded by gemini-3.8-flash-tts.
  [GoogleModels.Gemini_31_Flash_TTS_Preview]: {
    input: 1.0, output_audio: 20.0, output: 20.0,
    replacedBy: GoogleModels.Gemini_38_Flash_TTS,
  },
  // ── Gemini 3 (Pro / Pro Image / Omni) ─────────────────────────────────────
  [GoogleModels.Gemini_3_Pro_Preview]: {
    input: 2, input_gt_200k: 4, output: 12, output_gt_200k: 18,
    context_caching: 0.2, context_caching_gt_200k: 0.4, context_caching_storage: 4.5,
    deprecated: true, replacedBy: GoogleModels.Gemini_31_Pro_Preview,
  },
  [GoogleModels.Gemini_3_Pro_Image]: {
    input: 2, output: 12, image_generation: 0.134, image_generation_per_1m_tokens: 120.0,
  },
  // Interactions-API-only preview of Omni; superseded by gemini-omni-1.2-flash.
  [GoogleModels.Gemini_Omni_Flash_Preview]: {
    input: 1.5, output: 9.0,
    limitedAvailability: true,
    replacedBy: GoogleModels.Gemini_Omni_12_Flash,
  },
  // ── Gemini Omni (video) ───────────────────────────────────────────────────
  // Paid tier only. Video output is billed per token: 5,792 tokens per second
  // of 720p (1,931/s 360p, 8,688/s 1080p upsampled, 17,376/s 4K upsampled).
  // At $12/1M that's ~$0.07/s at 720p — video_generation is that per-second
  // estimate, used before the real token usage is known.
  [GoogleModels.Gemini_Omni_12_Flash]: {
    input: 1.5, output: 9.0,
    output_video_per_1m_tokens: 12.0,
    video_generation: 0.07,
  },
  // Previous generation. Effective December 3, 2026 Google routes every
  // request to gemini-omni-1.2-flash and bills at 1.2 rates.
  [GoogleModels.Gemini_Omni_11_Flash]: {
    input: 1.5, output: 9.0,
    output_video_per_1m_tokens: 17.5,
    video_generation: 0.10,
    deprecated: true, deprecationDate: "2026-12-03",
    replacedBy: GoogleModels.Gemini_Omni_12_Flash,
    routesTo: GoogleModels.Gemini_Omni_12_Flash, routesToDate: "2026-12-03",
  },
  // ── Lyria (music) — flat price per generated song/clip, paid tier only ────
  [GoogleModels.Lyria_35]: { audio_generation: 0.08 },
  [GoogleModels.Lyria_3_Clip_Preview]: { audio_generation: 0.04 },
  // Legacy: superseded by Lyria 3.5 (same price) — still served.
  [GoogleModels.Lyria_3_Pro_Preview]: {
    audio_generation: 0.08,
    deprecated: true, replacedBy: GoogleModels.Lyria_35,
  },
  // ── Robotics-ER ───────────────────────────────────────────────────────────
  [GoogleModels.Gemini_Robotics_ER_16_Preview]: {
    input: 1.0, input_audio: 2.0, output: 5.0,
  },
  [GoogleModels.Gemini_Robotics_ER_15_Preview]: {
    input: 1.0, input_audio: 2.0, output: 5.0,
    deprecated: true, replacedBy: GoogleModels.Gemini_Robotics_ER_16_Preview,
  },
  [GoogleModels.Gemini_31_Pro_Preview]: {
    input: 2, input_gt_200k: 4, output: 12, output_gt_200k: 18,
    context_caching: 0.2, context_caching_gt_200k: 0.4, context_caching_storage: 4.5,
  },
  // Preview of Nano Banana 2 → GA gemini-3.1-flash-image → gemini-nano-banana-2.1.
  [GoogleModels.Gemini_31_Flash_Image_Preview]: {
    input: 0.25, output: 60.0, image_generation: 0.045, image_generation_per_1m_tokens: 60.0,
    replacedBy: GoogleModels.Gemini_31_Flash_Image,
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
  // Preview of Nano Banana Pro → GA gemini-3-pro-image.
  [GoogleModels.Gemini_3_Pro_Image_Preview]: {
    input: 2, output: 12, image_generation: 0.134,
    replacedBy: GoogleModels.Gemini_3_Pro_Image,
  },
  // Deprecated: effective December 1, 2026 Google routes all requests to
  // gemini-3.8-flash and bills at 3.8 Flash rates.
  [GoogleModels.Gemini_25_Pro]: {
    input: 1.25, input_gt_200k: 2.5, output: 10.0, output_gt_200k: 15.0,
    context_caching: 0.125, context_caching_gt_200k: 0.25, context_caching_storage: 4.5,
    deprecated: true, deprecationDate: "2026-12-01",
    replacedBy: GoogleModels.Gemini_38_Flash,
    routesTo: GoogleModels.Gemini_38_Flash, routesToDate: "2026-12-01",
  },
  // Deprecated: effective December 1, 2026 Google routes all requests to
  // gemini-3.5-flash-lite and bills at 3.5 Flash-Lite rates.
  [GoogleModels.Gemini_25_Flash]: {
    input: 0.3, input_audio: 1.0, output: 2.5,
    context_caching: 0.03, context_caching_audio: 0.1, context_caching_storage: 1.0,
    deprecated: true, deprecationDate: "2026-12-01",
    replacedBy: GoogleModels.Gemini_35_Flash_Lite,
    routesTo: GoogleModels.Gemini_35_Flash_Lite, routesToDate: "2026-12-01",
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
  // Original Nano Banana → Nano Banana 2 (gemini-3.1-flash-image) → 2.1.
  [GoogleModels.Gemini_25_Flash_Image]: {
    input: 0.3, output: 30.0, image_generation: 0.039, image_generation_per_1m_tokens: 30.0,
    replacedBy: GoogleModels.Gemini_31_Flash_Image,
  },
  [GoogleModels.Gemini_25_Flash_Image_Preview]: {
    input: 0.3, output: 30.0, image_generation: 0.039, image_generation_per_1m_tokens: 30.0,
    replacedBy: GoogleModels.Gemini_25_Flash_Image,
  },
  [GoogleModels.Gemini_25_Flash_Live]: { input: 0.5, input_audio: 3.0, output: 2.0, output_audio: 12.0 },
  [GoogleModels.Gemini_25_Flash_Native_Audio]: { input: 0.5, input_audio: 3.0, output: 2.0, output_audio: 12.0 },
  // 2.x TTS models are superseded by the 3.8 TTS family.
  [GoogleModels.Gemini_25_Flash_TTS]: { input: 0.5, output_audio: 10.0, output: 10.0, replacedBy: GoogleModels.Gemini_38_Flash_TTS },
  [GoogleModels.Gemini_25_Pro_TTS]: { input: 1.0, output_audio: 20.0, output: 20.0, replacedBy: GoogleModels.Gemini_38_Flash_TTS },
  [GoogleModels.Gemini_20_Flash_TTS]: { input: 0.1, output_audio: 4.0, output: 4.0, replacedBy: GoogleModels.Gemini_38_Flash_Lite_TTS },
  [GoogleModels.Gemini_20_Flash]: {
    input: 0.1, input_audio: 0.7, output: 0.4,
    context_caching: 0.025, context_caching_audio: 0.175, context_caching_storage: 1.0,
  },
  [GoogleModels.Gemini_25_Computer_Use_Preview]: {
    input: 1.25, input_gt_200k: 2.5, output: 10.0, output_gt_200k: 15.0,
    limitedAvailability: true,
  },
  [GoogleModels.Gemini_20_Flash_Preview_Image_Generation]: { input: 0.1, output: 0.4, image_generation: 0.039, replacedBy: GoogleModels.Gemini_25_Flash_Image },
  [GoogleModels.Gemini_20_Flash_Live]: { input: 0.1, output: 0.4 },
  [GoogleModels.Gemini_20_Flash_Lite]: { input: 0.075, output: 0.3, deprecated: true, deprecationDate: "2026-06-01" },
  [GoogleModels.Gemini_15_Flash]:   { input: 0.075, output: 0.3,  context_caching: 0.01875, deprecated: true },
  [GoogleModels.Gemini_15_Flash_8B]:{ input: 0.0375, output: 0.15, context_caching: 0.01,   deprecated: true },
  [GoogleModels.Gemini_15_Pro]:     { input: 1.25, output: 5.0,   context_caching: 0.3125,  deprecated: true },
  // Imagen and Veo are no longer served by the Gemini API (models.get → 404,
  // absent from the pricing page). Veo 3.1 Preview shut down 2026-10-22.
  [GoogleModels.Imagen_3]: { image_generation: 0.04, deprecated: true, replacedBy: GoogleModels.Gemini_Nano_Banana_21 },
  [GoogleModels.Imagen_4_Fast]: { image_generation: 0.02, deprecated: true, replacedBy: GoogleModels.Gemini_Nano_Banana_21 },
  [GoogleModels.Imagen_4_Ultra]: { image_generation: 0.06, deprecated: true, replacedBy: GoogleModels.Gemini_Nano_Banana_21 },
  [GoogleModels.Veo_2]: { video_generation: 0.35, deprecated: true, replacedBy: GoogleModels.Gemini_Omni_12_Flash },
  [GoogleModels.Veo_3]: { video_generation: 0.4, deprecated: true, replacedBy: GoogleModels.Gemini_Omni_12_Flash },
  [GoogleModels.Veo_3_Fast]: { video_generation: 0.1, deprecated: true, replacedBy: GoogleModels.Gemini_Omni_12_Flash },
  [GoogleModels.Veo_3_1]: { video_generation: 0.4, deprecated: true, deprecationDate: "2026-10-22", replacedBy: GoogleModels.Gemini_Omni_12_Flash },
  [GoogleModels.Veo_3_1_Fast]: { video_generation: 0.1, deprecated: true, deprecationDate: "2026-10-22", replacedBy: GoogleModels.Gemini_Omni_12_Flash },
  [GoogleModels.Veo_3_1_Lite]: { video_generation: 0.05, deprecated: true, deprecationDate: "2026-10-22", replacedBy: GoogleModels.Gemini_Omni_12_Flash },
  [GoogleEmbeddingModels.Gemini_Embedding]: { input: 0 },
  [GoogleEmbeddingModels.Gemini_Embedding_001]: { input: 0.15 },
  [GoogleEmbeddingModels.Gemini_Embedding_2]: { input: 0.2 },
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
  ...decisions(GoogleDecisionModels,   "google", GeminiPricing),
  ...audios(GoogleTTSModels,           "google", GeminiPricing),
  ...audios(GoogleMusicModels,         "google", GeminiPricing),
];
