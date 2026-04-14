import { Models, EmbeddingModels } from "../../types";

/**
 * Gemini model pricing per 1M tokens (USD).
 *
 * Many models have modality-dependent pricing:
 * - `input`: text / image / video input rate
 * - `input_audio`: audio input rate (if different from text)
 * - `output`: text output rate
 * - `output_audio`: audio output rate (if different from text)
 * - `context_caching`: context cache read rate (text/image/video)
 * - `context_caching_audio`: context cache read rate for audio tokens
 * - `context_caching_gt_200k`: rate for prompts > 200k tokens
 * - `context_caching_storage`: storage cost per 1M tokens per hour
 * - `image_generation`: per-image cost for image output models
 * - `video_generation`: per-second cost for video generation models
 */
export interface GeminiModelPricing {
  input?: number;
  input_audio?: number;
  input_gt_200k?: number;
  output?: number;
  output_audio?: number;
  output_gt_200k?: number;
  context_caching?: number;
  context_caching_audio?: number;
  context_caching_gt_200k?: number;
  context_caching_storage?: number; // per 1M tokens per hour
  image_generation?: number;
  video_generation?: number;
  thinking_output?: number;
}

export const GeminiPricing: Record<string, GeminiModelPricing> = {
  // ── Gemini 3.x ────────────────────────────────────────────────────────────
  [Models.google.Gemini_31_Pro_Preview]: {
    input: 2,
    input_gt_200k: 4,
    output: 12,
    output_gt_200k: 18,
    context_caching: 0.2,
    context_caching_gt_200k: 0.4,
    context_caching_storage: 4.5,
  },
  // gemini-3.1-flash-image-preview: text/image input, text+image output
  [Models.google.Gemini_31_Flash_Image_Preview]: {
    input: 0.5,
    output: 3,
    image_generation: 0.045, // per 0.5K image ($60/1M tokens × 747 tokens)
  },
  // gemini-3.1-flash-lite-preview: audio input costs 2× text
  [Models.google.Gemini_31_Flash_Lite_Preview]: {
    input: 0.25,
    input_audio: 0.5,
    output: 1.5,
    context_caching: 0.025,
    context_caching_audio: 0.05,
    context_caching_storage: 1.0,
  },
  // gemini-3.1-flash-live-preview: Live API, per-modality rates
  // Input: $0.75 text, $3.00 audio/video, $1.00 image
  // Output: $4.50 text, $12.00 audio
  [Models.google.Gemini_31_Flash_Live_Preview]: {
    input: 0.75,        // text
    input_audio: 3.0,   // audio / video
    output: 4.5,        // text
    output_audio: 12.0, // audio
  },
  // gemini-3-flash-preview: audio input costs 2× text
  [Models.google.Gemini_3_Flash_Preview]: {
    input: 0.5,
    input_audio: 1.0,
    output: 3.0,
    context_caching: 0.05,
    context_caching_audio: 0.10,
    context_caching_storage: 1.0,
  },
  // gemini-3-pro-image-preview: text+image input, text+image output
  [Models.google.Gemini_3_Pro_Image_Preview]: {
    input: 2,
    output: 12,
    image_generation: 0.134, // per 1K/2K image ($120/1M tokens × 1120 tokens)
  },

  // ── Gemini 2.5 ────────────────────────────────────────────────────────────
  [Models.google.Gemini_25_Pro]: {
    input: 1.25,
    input_gt_200k: 2.5,
    output: 10.0,
    output_gt_200k: 15.0,
    context_caching: 0.125,
    context_caching_gt_200k: 0.25,
    context_caching_storage: 4.5,
  },
  // gemini-2.5-flash: audio input costs 3.3× text; audio caching 3.3× text
  [Models.google.Gemini_25_Flash]: {
    input: 0.3,
    input_audio: 1.0,
    output: 2.5,
    context_caching: 0.03,
    context_caching_audio: 0.1,
    context_caching_storage: 1.0,
  },
  // gemini-2.5-flash-lite: audio input costs 3× text; audio caching 3× text
  [Models.google.Gemini_25_Flash_Lite]: {
    input: 0.1,
    input_audio: 0.3,
    output: 0.4,
    context_caching: 0.01,
    context_caching_audio: 0.03,
    context_caching_storage: 1.0,
  },
  // gemini-2.5-flash-preview-05-20: same modality splits as 2.5 Flash
  [Models.google.Gemini_25_Flash_Preview]: {
    input: 0.3,
    input_audio: 1.0,
    output: 2.5,
    context_caching: 0.03,
    context_caching_audio: 0.1,
    context_caching_storage: 1.0,
  },
  [Models.google.Gemini_25_Pro_Preview]: {
    input: 1.25,
    input_gt_200k: 2.5,
    output: 10.0,
    output_gt_200k: 15.0,
    context_caching: 0.125,
    context_caching_gt_200k: 0.25,
    context_caching_storage: 4.5,
  },
  // gemini-2.5-flash-image: image output model, per-image pricing
  [Models.google.Gemini_25_Flash_Image]: {
    input: 0.3,
    output: 0.039, // per image ($30/1M tokens × 1290 tokens)
  },
  // gemini-2.5-flash-live / gemini-2.5-flash-native-audio-preview-12-2025:
  // Live API models — audio I/O costs dramatically more than text
  // Input: $0.50 text, $3.00 audio/video
  // Output: $2.00 text, $12.00 audio
  [Models.google.Gemini_25_Flash_Live]: {
    input: 0.5,
    input_audio: 3.0,
    output: 2.0,
    output_audio: 12.0,
  },
  [Models.google.Gemini_25_Flash_Native_Audio]: {
    input: 0.5,
    input_audio: 3.0,
    output: 2.0,
    output_audio: 12.0,
  },
  // TTS models: text-only input, audio-only output
  [Models.google.Gemini_25_Flash_TTS]: {
    input: 0.5,
    output_audio: 10.0,
  },
  [Models.google.Gemini_25_Pro_TTS]: {
    input: 1.0,
    output_audio: 20.0,
  },

  // ── Gemini 2.0 (deprecated) ───────────────────────────────────────────────
  // gemini-2.0-flash: audio input costs 7× text; audio caching costs 7× text
  [Models.google.Gemini_20_Flash]: {
    input: 0.1,
    input_audio: 0.7,
    output: 0.4,
    context_caching: 0.025,
    context_caching_audio: 0.175,
    context_caching_storage: 1.0,
  },
  [Models.google.Gemini_20_Flash_Preview_Image_Generation]: {
    input: 0.1,
    output: 0.4,
    image_generation: 0.039,
  },

  // ── Gemini 1.5 (legacy) ───────────────────────────────────────────────────
  [Models.google.Gemini_15_Flash]: {
    input: 0.075,
    output: 0.3,
    context_caching: 0.01875,
  },
  [Models.google.Gemini_15_Flash_8B]: {
    input: 0.0375,
    output: 0.15,
    context_caching: 0.01,
  },
  [Models.google.Gemini_15_Pro]: {
    input: 1.25,
    output: 5.0,
    context_caching: 0.3125,
  },

  // ── Image generation ──────────────────────────────────────────────────────
  [Models.google.Imagen_3]: {
    image_generation: 0.04, // $0.04/image (Imagen 4 Standard)
  },
  [Models.google.Imagen_4_Fast]: {
    image_generation: 0.02,
  },
  [Models.google.Imagen_4_Ultra]: {
    image_generation: 0.06,
  },

  // ── Video generation ──────────────────────────────────────────────────────
  [Models.google.Veo_2]: {
    video_generation: 0.35, // per second
  },
  [Models.google.Veo_3]: {
    video_generation: 0.4,
  },
  [Models.google.Veo_3_Fast]: {
    video_generation: 0.1, // 720p base rate; 1080p=$0.12, 4k=$0.30 not expressible here
  },
  [Models.google.Veo_3_1]: {
    video_generation: 0.4, // 720p/1080p; 4k=$0.60 not expressible as single scalar
  },
  [Models.google.Veo_3_1_Fast]: {
    video_generation: 0.1, // 720p base; 1080p=$0.12, 4k=$0.30
  },

  // ── Embeddings ────────────────────────────────────────────────────────────
  [EmbeddingModels.google.Gemini_Embedding]: {
    input: 0, // Free of charge
  },
  [EmbeddingModels.google.Gemini_Embedding_001]: {
    input: 0.15,
  },
};

/**
 * @deprecated Use GeminiPricing instead.
 * Kept as alias for backwards compatibility.
 */
export const GeminiTextPricing = GeminiPricing;
