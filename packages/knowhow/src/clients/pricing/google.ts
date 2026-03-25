import { Models, EmbeddingModels } from "../../types";

export const GeminiTextPricing = {
  // Gemini 3.x
  [Models.google.Gemini_31_Pro_Preview]: {
    input: 2,
    input_gt_200k: 4,
    output: 12,
    output_gt_200k: 18,
    context_caching: 0.2,
    context_caching_gt_200k: 0.4,
  },
  [Models.google.Gemini_31_Flash_Image_Preview]: {
    input: 0.5,
    output: 3,
    image_generation: 0.045, // per 0.5K image
  },
  [Models.google.Gemini_31_Flash_Lite_Preview]: {
    input: 0.25,
    output: 1.5,
    context_caching: 0.025,
  },
  [Models.google.Gemini_3_Flash_Preview]: {
    input: 0.5,
    output: 3.0,
    context_caching: 0.05,
  },
  [Models.google.Gemini_3_Pro_Image_Preview]: {
    input: 2,
    output: 12,
    image_generation: 0.134, // per 1K/2K image
  },
  // Gemini 2.5
  [Models.google.Gemini_25_Pro]: {
    input: 1.25,
    input_gt_200k: 2.5,
    output: 10.0,
    output_gt_200k: 15.0,
    context_caching: 0.125,
    context_caching_gt_200k: 0.25,
  },
  [Models.google.Gemini_25_Flash]: {
    input: 0.3,
    output: 2.5,
    context_caching: 0.03,
  },
  [Models.google.Gemini_25_Flash_Lite]: {
    input: 0.1,
    output: 0.4,
    context_caching: 0.01,
  },
  [Models.google.Gemini_25_Flash_Preview]: {
    input: 0.3,
    output: 2.5,
    thinking_output: 3.5,
    context_caching: 0.0375,
  },
  [Models.google.Gemini_25_Pro_Preview]: {
    input: 1.25,
    input_gt_200k: 2.5,
    output: 10.0,
    output_gt_200k: 15.0,
    context_caching: 0.125,
    context_caching_gt_200k: 0.25,
  },
  [Models.google.Gemini_25_Flash_Image]: {
    input: 0.3,
    output: 0.039, // per image ($30/1M tokens, 1290 tokens per image)
  },
  [Models.google.Gemini_25_Flash_TTS]: {
    input: 0.5,
    output: 10.0,
  },
  [Models.google.Gemini_25_Pro_TTS]: {
    input: 1.0,
    output: 20.0,
  },
  // Gemini 2.0 (deprecated)
  [Models.google.Gemini_20_Flash]: {
    input: 0.1,
    output: 0.4,
    context_caching: 0.025,
  },
  [Models.google.Gemini_20_Flash_Preview_Image_Generation]: {
    input: 0.1,
    output: 0.4,
    image_generation: 0.039,
  },
  [Models.google.Gemini_20_Flash_Lite]: {
    input: 0.075,
    output: 0.3,
  },
  // Gemini 1.5 (legacy)
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
  // Image generation
  [Models.google.Imagen_3]: {
    image_generation: 0.04, // Imagen 4 Standard: $0.04/image
  },
  [Models.google.Imagen_4_Fast]: {
    image_generation: 0.02, // $0.02/image
  },
  [Models.google.Imagen_4_Ultra]: {
    image_generation: 0.06, // $0.06/image
  },
  // Video generation
  [Models.google.Veo_2]: {
    video_generation: 0.35,
  },
  [Models.google.Veo_3]: {
    video_generation: 0.4, // $0.40/second
  },
  [Models.google.Veo_3_Fast]: {
    video_generation: 0.15, // $0.15/second
  },
  [Models.google.Veo_3_1]: {
    video_generation: 0.4, // $0.40/second (720p/1080p)
  },
  [Models.google.Veo_3_1_Fast]: {
    video_generation: 0.15, // $0.15/second
  },
  // Embeddings
  [EmbeddingModels.google.Gemini_Embedding]: {
    input: 0, // Free of charge
    output: 0, // Free of charge
  },
  [EmbeddingModels.google.Gemini_Embedding_001]: {
    input: 0.15,
    output: 0,
  },
};
