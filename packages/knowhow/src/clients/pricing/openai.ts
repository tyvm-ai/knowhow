/**
 * OpenAI model IDs, pricing, and catalog.
 * Single source of truth for all OpenAI models.
 */
import {
  completions,
  embeddings,
  images,
  videos,
  audios,
  transactions,
  ModelCatalogEntry,
  ModelPricing,
} from "./types";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const OpenAiModels = {
  GPT_56_Sol: "gpt-5.6-sol",
  GPT_56_Terra: "gpt-5.6-terra",
  GPT_56_Luna: "gpt-5.6-luna",
  GPT_55: "gpt-5.5",
  GPT_55_Pro: "gpt-5.5-pro",
  GPT_54: "gpt-5.4",
  GPT_54_Mini: "gpt-5.4-mini",
  GPT_54_Nano: "gpt-5.4-nano",
  GPT_54_Pro: "gpt-5.4-pro",
  GPT_53_Chat: "gpt-5.3-chat-latest",
  GPT_53_Codex: "gpt-5.3-codex",
  GPT_53_Codex_Spark: "gpt-5.3-codex-spark",
  GPT_52: "gpt-5.2",
  GPT_52_Chat: "gpt-5.2-chat-latest",
  GPT_52_Codex: "gpt-5.2-codex",
  GPT_52_Pro: "gpt-5.2-pro",
  GPT_51: "gpt-5.1",
  GPT_51_Chat: "gpt-5.1-chat-latest",
  GPT_51_Codex: "gpt-5.1-codex",
  GPT_51_Codex_Max: "gpt-5.1-codex-max",
  GPT_51_Codex_Mini: "gpt-5.1-codex-mini",
  GPT_5: "gpt-5",
  GPT_5_Pro: "gpt-5-pro",
  GPT_5_Chat: "gpt-5-chat-latest",
  GPT_5_Codex: "gpt-5-codex",
  GPT_5_Mini: "gpt-5-mini",
  GPT_5_Nano: "gpt-5-nano",
  GPT_41: "gpt-4.1-2025-04-14",
  GPT_41_Mini: "gpt-4.1-mini-2025-04-14",
  GPT_41_Nano: "gpt-4.1-nano-2025-04-14",
  GPT_45: "gpt-4.5-preview-2025-02-27",
  GPT_4o: "gpt-4o-2024-08-06",
  GPT_4o_Audio: "gpt-4o-audio-preview-2024-12-17",
  GPT_4o_Realtime: "gpt-4o-realtime-preview-2024-12-17",
  GPT_4o_Mini: "gpt-4o-mini-2024-07-18",
  GPT_4o_Mini_Audio: "gpt-4o-mini-audio-preview-2024-12-17",
  GPT_4o_Mini_Realtime: "gpt-4o-mini-realtime-preview-2024-12-17",
  o1: "o1-2024-12-17",
  o1_Pro: "o1-pro-2025-03-19",
  o3: "o3-2025-04-16",
  o3_Pro: "o3-pro-2025-01-31",
  o4_Mini: "o4-mini-2025-04-16",
  o3_Mini: "o3-mini-2025-01-31",
  o1_Mini: "o1-mini-2024-09-12",
  o1_Preview: "o1-preview",
  o3_Deep_Research: "o3-deep-research",
  o4_Mini_Deep_Research: "o4-mini-deep-research",
  GPT_4o_Mini_Search: "gpt-4o-mini-search-preview-2025-03-11",
  GPT_4o_Search: "gpt-4o-search-preview-2025-03-11",
  GPT_4o_Transcribe: "gpt-4o-transcribe",
  GPT_4o_Mini_Transcribe: "gpt-4o-mini-transcribe",
  GPT_Realtime_15: "gpt-realtime-1.5",
  GPT_Realtime_Mini: "gpt-realtime-mini",
  GPT_Image_2: "gpt-image-2",
  GPT_Image_15: "gpt-image-1.5",
  GPT_Image_1: "gpt-image-1",
  GPT_Image_1_Mini: "gpt-image-1-mini",
  ChatGPT_Image: "chatgpt-image-latest",
  TTS_1: "tts-1",
  Whisper_1: "whisper-1",
  DALL_E_3: "dall-e-3",
  DALL_E_2: "dall-e-2",
  Sora: "sora",
  Sora_2: "sora-2",
  Sora_2_Pro: "sora-2-pro",
  GPT_4o_2024_05_13: "gpt-4o-2024-05-13",
  GPT_4o_2024_11_20: "gpt-4o-2024-11-20",
  GPT_35_Turbo: "gpt-3.5-turbo",
  GPT_4: "gpt-4",
  GPT_4_Turbo: "gpt-4-turbo",
} as const;

export const OpenAiEmbeddingModels: Record<string, string> = {
  EmbeddingAda2: "text-embedding-ada-002",
  EmbeddingLarge3: "text-embedding-3-large",
  EmbeddingSmall3: "text-embedding-3-small",
};

// ─── Modality arrays ──────────────────────────────────────────────────────────

export const OpenAiReasoningModels: string[] = [
  OpenAiModels.GPT_5,
  OpenAiModels.GPT_56_Sol,
  OpenAiModels.GPT_56_Terra,
  OpenAiModels.GPT_56_Luna,
  OpenAiModels.GPT_5_Pro,
  OpenAiModels.GPT_5_Mini,
  OpenAiModels.GPT_5_Nano,
  OpenAiModels.GPT_51,
  OpenAiModels.GPT_51,
  OpenAiModels.GPT_52,
  OpenAiModels.GPT_52_Pro,
  OpenAiModels.GPT_53_Chat,
  OpenAiModels.GPT_53_Codex,
  OpenAiModels.GPT_54,
  OpenAiModels.GPT_54_Mini,
  OpenAiModels.GPT_54_Nano,
  OpenAiModels.GPT_54_Pro,
  OpenAiModels.GPT_55,
  OpenAiModels.GPT_55_Pro,
  OpenAiModels.GPT_5_Mini,
  OpenAiModels.GPT_5_Nano,
  OpenAiModels.GPT_5_Pro,
  OpenAiModels.o3,
  OpenAiModels.o3_Mini,
  OpenAiModels.o4_Mini,
];

export const OpenAiChatModels: string[] = [
  OpenAiModels.GPT_4o,
  OpenAiModels.GPT_4o_Mini,
  OpenAiModels.GPT_4o_2024_11_20,
  OpenAiModels.GPT_41,
  OpenAiModels.GPT_41_Mini,
  OpenAiModels.GPT_41_Nano,
  OpenAiModels.GPT_56_Sol,
  OpenAiModels.GPT_56_Terra,
  OpenAiModels.GPT_56_Luna,
  OpenAiModels.GPT_54,
  OpenAiModels.GPT_54_Mini,
  OpenAiModels.GPT_55,
  OpenAiModels.GPT_54_Nano,
  OpenAiModels.GPT_54_Pro,
  OpenAiModels.GPT_53_Chat,
  OpenAiModels.GPT_53_Codex,
  OpenAiModels.GPT_51,
  OpenAiModels.GPT_52,
  OpenAiModels.o3,
  OpenAiModels.o3_Mini,
  OpenAiModels.o4_Mini,
];

export const OpenAiEmbeddingModelsList: string[] = [
  OpenAiEmbeddingModels.EmbeddingAda2,
  OpenAiEmbeddingModels.EmbeddingLarge3,
  OpenAiEmbeddingModels.EmbeddingSmall3,
];

export const OpenAiResponsesOnlyModels: string[] = [
  OpenAiModels.GPT_5,
  OpenAiModels.GPT_5_Mini,
  OpenAiModels.GPT_5_Nano,
  OpenAiModels.GPT_52_Pro,
  OpenAiModels.GPT_53_Codex,
  OpenAiModels.GPT_54,
  OpenAiModels.GPT_54_Mini,
  OpenAiModels.GPT_54_Nano,
  OpenAiModels.GPT_54_Pro,
  OpenAiModels.GPT_55_Pro,
  OpenAiModels.GPT_55,
  OpenAiModels.GPT_5_Pro,
  OpenAiModels.o1,
  OpenAiModels.o1_Pro,
];

// Models that exist in our catalog but have limited/no public access
export const OpenAiLimitedAvailabilityModels: string[] = [
  OpenAiModels.GPT_53_Codex_Spark, // 404 – not publicly available
  OpenAiModels.o3_Pro, // 404 – not publicly available
];

// Image models
export const OpenAiImageModels: string[] = [
  OpenAiModels.DALL_E_3,
  OpenAiModels.DALL_E_2,
  OpenAiModels.GPT_Image_2,
  OpenAiModels.GPT_Image_15,
  OpenAiModels.GPT_Image_1_Mini,
  OpenAiModels.ChatGPT_Image,
];
export const OpenAiDeprecatedImageModels: string[] = [OpenAiModels.GPT_Image_1];

// Video models
export const OpenAiVideoModels: string[] = [
  OpenAiModels.Sora,
  OpenAiModels.Sora_2,
  OpenAiModels.Sora_2_Pro,
];

// Audio models
export const OpenAiTTSModels: string[] = [OpenAiModels.TTS_1];
export const OpenAiTranscriptionModels: string[] = [
  OpenAiModels.Whisper_1,
  OpenAiModels.GPT_4o_Transcribe,
  OpenAiModels.GPT_4o_Mini_Transcribe,
];
export const OpenAiRealtimeModels: string[] = [
  OpenAiModels.GPT_Realtime_15,
  OpenAiModels.GPT_Realtime_Mini,
];
export const OpenAiAudioModels: string[] = [
  ...OpenAiTTSModels,
  ...OpenAiTranscriptionModels,
  ...OpenAiRealtimeModels,
];
export const OpenAiDeprecatedAudioModels: string[] = [
  OpenAiModels.GPT_4o_Audio,
  OpenAiModels.GPT_4o_Mini_Audio,
  OpenAiModels.GPT_4o_Realtime,
  OpenAiModels.GPT_4o_Mini_Realtime,
];

// Search/transaction models
export const OpenAiSearchModels: string[] = [
  OpenAiModels.GPT_4o_Mini_Search,
  OpenAiModels.GPT_4o_Search,
];

// ─── Pricing (USD per 1M tokens) ──────────────────────────────────────────────

export const OpenAiTextPricing: Record<string, ModelPricing> = {
  // gpt-5.6 series — short context / long context pricing
  [OpenAiModels.GPT_56_Sol]:   { input: 5.0, cached_input: 0.5,  cache_write: 6.25,  output: 30.0, input_gt_200k: 10.0, output_gt_200k: 45.0 },
  [OpenAiModels.GPT_56_Terra]: { input: 2.5, cached_input: 0.25, cache_write: 3.125, output: 15.0, input_gt_200k: 5.0,  output_gt_200k: 22.5 },
  [OpenAiModels.GPT_56_Luna]:  { input: 1.0, cached_input: 0.10, cache_write: 1.25,  output: 6.0,  input_gt_200k: 2.0,  output_gt_200k: 9.0  },
  [OpenAiModels.GPT_55]: { input: 5.0, cached_input: 0.5, output: 30.0 },
  [OpenAiModels.GPT_55_Pro]: { input: 30.0, cached_input: 0, output: 180.0, reasoningLevels: ["medium", "high", "xhigh"] },
  [OpenAiModels.GPT_54]: { input: 2.5, cached_input: 0.25, output: 15.0 },
  [OpenAiModels.GPT_54_Mini]: { input: 0.75, cached_input: 0.075, output: 4.5 },
  [OpenAiModels.GPT_54_Nano]: { input: 0.2, cached_input: 0.02, output: 1.25 },
  [OpenAiModels.GPT_54_Pro]: { input: 30.0, cached_input: 0, output: 180.0 },
  [OpenAiModels.GPT_53_Chat]: {
    input: 1.75,
    cached_input: 0.175,
    output: 14.0,
  },
  [OpenAiModels.GPT_53_Codex]: {
    input: 1.75,
    cached_input: 0.175,
    output: 14.0,
  },
  [OpenAiModels.GPT_53_Codex_Spark]: {
    input: 1.75,
    cached_input: 0.175,
    output: 14.0,
    limitedAvailability: true,
  },
  [OpenAiModels.GPT_52]: { input: 1.75, cached_input: 0.175, output: 14.0 },
  [OpenAiModels.GPT_52_Chat]:  { input: 1.75, cached_input: 0.175, output: 14.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_52_Codex]: { input: 1.75, cached_input: 0.175, output: 14.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_52_Pro]: { input: 21.0, cached_input: 0, output: 168.0, reasoningLevels: ["medium", "high", "xhigh"] },
  [OpenAiModels.GPT_51]: { input: 1.25, cached_input: 0.125, output: 10.0 },
  [OpenAiModels.GPT_51_Chat]:      { input: 1.25, cached_input: 0.125, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_51_Codex]:     { input: 1.25, cached_input: 0.125, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_51_Codex_Max]: { input: 1.25, cached_input: 0.125, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_51_Codex_Mini]:{ input: 0.25, cached_input: 0.025, output: 2.0,  deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_5]: { input: 1.25, cached_input: 0.125, output: 10.0 },
  [OpenAiModels.GPT_5_Pro]: { input: 15.0, cached_input: 0, output: 120.0, reasoningLevels: ["high"] },
  [OpenAiModels.GPT_5_Chat]: { input: 1.25, cached_input: 0.125, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_5_Codex]: { input: 1.25, cached_input: 0.125, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_5_Mini]: { input: 0.25, cached_input: 0.025, output: 2.0 },
  [OpenAiModels.GPT_5_Nano]: { input: 0.05, cached_input: 0.005, output: 0.4 },
  [OpenAiModels.GPT_41]: { input: 2.0, cached_input: 0.5, output: 8.0 },
  [OpenAiModels.GPT_41_Mini]: { input: 0.4, cached_input: 0.1, output: 1.6 },
  [OpenAiModels.GPT_41_Nano]: { input: 0.1, cached_input: 0.025, output: 0.4, deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.GPT_45]: { input: 75.0, cached_input: 37.5, output: 150.0, deprecated: true, deprecationDate: "2025-07-14", replacedBy: OpenAiModels.GPT_41 },
  [OpenAiModels.GPT_4o]: { input: 2.5, cached_input: 1.25, output: 10.0 },
  [OpenAiModels.GPT_4o_Audio]:   { input: 2.5, cached_input: 0, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_4o_Realtime]: { input: 5.0, cached_input: 2.5, output: 20.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_4o_Mini]: { input: 0.15, cached_input: 0.075, output: 0.6 },
  [OpenAiModels.GPT_4o_Mini_Audio]:   { input: 0.15, cached_input: 0, output: 0.6, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_4o_Mini_Realtime]: { input: 0.6, cached_input: 0.3, output: 2.4, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.o1]:     { input: 15.0, cached_input: 7.5, output: 60.0, deprecated: true, deprecationDate: "2026-10-23", replacedBy: OpenAiModels.o3 },
  [OpenAiModels.o1_Pro]: { input: 150.0, cached_input: 0, output: 600.0, deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.o3]:     { input: 2.0, cached_input: 0.5, output: 8.0 },
  [OpenAiModels.o3_Pro]: { input: 20.0, cached_input: 0, output: 80.0, limitedAvailability: true },
  [OpenAiModels.o4_Mini]: { input: 1.1, cached_input: 0.275, output: 4.4 },
  [OpenAiModels.o3_Mini]:    { input: 1.1, cached_input: 0.55, output: 4.4, deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.o1_Mini]:    { input: 1.1, cached_input: 0.55, output: 4.4, deprecated: true, deprecationDate: "2025-10-27", replacedBy: OpenAiModels.o4_Mini },
  [OpenAiModels.o1_Preview]: { input: 15.0, cached_input: 7.5, output: 60.0, deprecated: true, deprecationDate: "2025-07-28", replacedBy: OpenAiModels.o3 },
  [OpenAiModels.o3_Deep_Research]:      { input: 10.0, cached_input: 2.5, output: 40.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.o4_Mini_Deep_Research]: { input: 2.0,  cached_input: 0.5, output: 8.0,  deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_4o_Mini_Search]: { input: 0.15, cached_input: 0, output: 0.6,  deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_4o_Search]:      { input: 2.5,  cached_input: 0, output: 10.0, deprecated: true, deprecationDate: "2026-07-23" },
  [OpenAiModels.GPT_4o_Transcribe]: {
    input: 2.5,
    cached_input: 0,
    output: 10.0,
  },
  [OpenAiModels.GPT_4o_Mini_Transcribe]: {
    input: 1.25,
    cached_input: 0,
    output: 5.0,
  },
  [OpenAiModels.GPT_Realtime_15]: {
    input: 4.0,
    cached_input: 0.4,
    output: 16.0,
  },
  [OpenAiModels.GPT_Realtime_Mini]: {
    input: 0.6,
    cached_input: 0.06,
    output: 2.4,
  },
  [OpenAiModels.GPT_Image_2]: { input: 8.0, cached_input: 2.0, output: 30.0 },
  [OpenAiModels.GPT_Image_15]: { input: 5.0, cached_input: 1.25, output: 10.0 },
  [OpenAiModels.GPT_Image_1]: { input: 5.0, cached_input: 1.25, output: 40.0, deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.GPT_Image_1_Mini]: { input: 2.0, cached_input: 0.2, output: 0 },
  [OpenAiModels.ChatGPT_Image]: {
    input: 5.0,
    cached_input: 1.25,
    output: 40.0,
  },
  [OpenAiModels.GPT_4o_2024_05_13]: { input: 5.0, cached_input: 0, output: 15.0, deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.GPT_4o_2024_11_20]: {
    input: 2.5,
    cached_input: 1.25,
    output: 10.0,
  },
  [OpenAiModels.GPT_35_Turbo]: { input: 0.5, cached_input: 0, output: 1.5,  deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.GPT_4]:        { input: 30.0, cached_input: 0, output: 60.0, deprecated: true, deprecationDate: "2026-10-23" },
  [OpenAiModels.GPT_4_Turbo]:  { input: 10.0, cached_input: 0, output: 30.0, deprecated: true, deprecationDate: "2026-10-23" },
  // Embeddings
  [OpenAiEmbeddingModels.EmbeddingAda2]: { input: 0.1, output: 0 },
  [OpenAiEmbeddingModels.EmbeddingLarge3]: { input: 0.13, output: 0 },
  [OpenAiEmbeddingModels.EmbeddingSmall3]: { input: 0.02, output: 0 },
  // TTS / Whisper
  [OpenAiModels.TTS_1]: { input: 15.0, output: 0 },
  [OpenAiModels.Whisper_1]: { input: 0.006, output: 0 },
  // Image generation (per-image)
  [OpenAiModels.DALL_E_3]: { image_generation: 0.04 },
  [OpenAiModels.DALL_E_2]: { image_generation: 0.02 },
  // Video generation (per second)
  [OpenAiModels.Sora]: { video_generation: 0.012 },
  [OpenAiModels.Sora_2]: { video_generation: 0.015 },
  [OpenAiModels.Sora_2_Pro]: { video_generation: 0.025 },
};

// ─── All completion model IDs (active + deprecated) ──────────────────────────
// Deprecation/replacement metadata is embedded in OpenAiTextPricing entries.

const OpenAiAllCompletionModels: string[] = [
  ...OpenAiChatModels,
  ...OpenAiResponsesOnlyModels,
  ...OpenAiLimitedAvailabilityModels,
  // Deprecated chat/codex variants
  OpenAiModels.GPT_5_Chat,       OpenAiModels.GPT_5_Codex,
  OpenAiModels.GPT_51_Chat,      OpenAiModels.GPT_51_Codex,
  OpenAiModels.GPT_51_Codex_Max, OpenAiModels.GPT_51_Codex_Mini,
  OpenAiModels.GPT_52_Chat,      OpenAiModels.GPT_52_Codex,
  OpenAiModels.o3_Deep_Research, OpenAiModels.o4_Mini_Deep_Research,
  // Deprecated reasoning
  OpenAiModels.o3_Mini,  OpenAiModels.o4_Mini,
  OpenAiModels.o1,       OpenAiModels.o1_Pro,
  OpenAiModels.o1_Mini,  OpenAiModels.o1_Preview,
  // Deprecated chat
  OpenAiModels.GPT_41_Nano,
  OpenAiModels.GPT_4o_2024_05_13,
  OpenAiModels.GPT_45,
  OpenAiModels.GPT_35_Turbo, OpenAiModels.GPT_4, OpenAiModels.GPT_4_Turbo,
];

const OpenAiAllImageModels: string[] = [
  ...OpenAiImageModels,
  ...OpenAiDeprecatedImageModels,
];

const OpenAiAllAudioModels: string[] = [
  ...OpenAiAudioModels,
  ...OpenAiDeprecatedAudioModels,
];

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Metadata (deprecated, deprecationDate, limitedAvailability, replacedBy) is
// read directly from the OpenAiTextPricing entries — no need for separate groups.

export const OPENAI_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...completions(OpenAiAllCompletionModels, "openai", OpenAiTextPricing),
  ...embeddings(OpenAiEmbeddingModelsList,  "openai", OpenAiTextPricing),
  ...images(OpenAiAllImageModels,           "openai", OpenAiTextPricing),
  ...videos(OpenAiVideoModels,              "openai", OpenAiTextPricing),
  ...audios(OpenAiAllAudioModels,           "openai", OpenAiTextPricing),
  ...transactions(OpenAiSearchModels,       "openai", OpenAiTextPricing),
];
