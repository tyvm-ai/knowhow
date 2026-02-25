import { Models, EmbeddingModels } from "../../types";

export const GeminiTextPricing = {
  [Models.google.Gemini_3_Preview]: {
    input: 2,
    input_gt_200k: 4,
    output: 12,
    output_gt_200k: 18,
    context_caching: 0.2,
    context_caching_gt_200k: 0.4,
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
  [Models.google.Imagen_3]: {
    image_generation: 0.03,
  },
  [Models.google.Veo_2]: {
    video_generation: 0.35,
  },
  [EmbeddingModels.google.Gemini_Embedding]: {
    input: 0, // Free of charge
    output: 0, // Free of charge
  },
};
