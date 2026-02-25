import { Models, EmbeddingModels } from "../../types";

export const OpenAiTextPricing = {
  [Models.openai.GPT_4o]: {
    input: 2.5,
    cached_input: 1.25,
    output: 10.0,
  },
  [Models.openai.GPT_4o_Mini]: {
    input: 0.15,
    cached_input: 0.075,
    output: 0.6,
  },
  [Models.openai.o1]: {
    input: 15.0,
    cached_input: 7.5,
    output: 60.0,
  },
  [Models.openai.o1_Mini]: {
    input: 1.1,
    cached_input: 0.55,
    output: 4.4,
  },
  [Models.openai.o3_Mini]: {
    input: 1.1,
    cached_input: 0.55,
    output: 4.4,
  },
  [Models.openai.GPT_41]: {
    input: 2.0,
    cached_input: 0.5,
    output: 8.0,
  },
  [Models.openai.GPT_41_Mini]: {
    input: 0.4,
    cached_input: 0.1,
    output: 1.6,
  },
  [Models.openai.GPT_41_Nano]: {
    input: 0.1,
    cached_input: 0.025,
    output: 0.4,
  },
  [Models.openai.GPT_45]: {
    input: 75.0,
    cached_input: 37.5,
    output: 150.0,
  },
  [Models.openai.GPT_4o_Audio]: {
    input: 2.5,
    cached_input: 0,
    output: 10.0,
  },
  [Models.openai.GPT_4o_Realtime]: {
    input: 5.0,
    cached_input: 2.5,
    output: 20.0,
  },
  [Models.openai.GPT_4o_Mini_Audio]: {
    input: 0.15,
    cached_input: 0,
    output: 0.6,
  },
  [Models.openai.GPT_4o_Mini_Realtime]: {
    input: 0.6,
    cached_input: 0.3,
    output: 2.4,
  },
  [Models.openai.o1_Pro]: {
    input: 150.0,
    cached_input: 0,
    output: 600.0,
  },
  [Models.openai.o3]: {
    input: 2.0,
    cached_input: 0.5,
    output: 8.0,
  },
  [Models.openai.o4_Mini]: {
    input: 1.1,
    cached_input: 0.275,
    output: 4.4,
  },
  [Models.openai.GPT_4o_Mini_Search]: {
    input: 0.15,
    cached_input: 0,
    output: 0.6,
  },
  [Models.openai.GPT_4o_Search]: {
    input: 2.5,
    cached_input: 0,
    output: 10.0,
  },
  [Models.openai.GPT_5_2]: {
    input: 1.75,
    cached_input: 0.175,
    output: 14,
  },
  [Models.openai.GPT_5_1]: {
    input: 1.25,
    cached_input: 0.125,
    output: 10,
  },
  [Models.openai.GPT_5]: {
    input: 1.25,
    cached_input: 0.125,
    output: 10,
  },
  [Models.openai.GPT_5_Mini]: {
    input: 0.25,
    cached_input: 0.025,
    output: 2,
  },
  [Models.openai.GPT_5_Nano]: {
    input: 0.05,
    cached_input: 0.005,
    output: 0.4,
  },
  [EmbeddingModels.openai.EmbeddingAda2]: {
    input: 0.1,
    cached_input: 0,
    output: 0,
  },
  [EmbeddingModels.openai.EmbeddingLarge3]: {
    input: 0.13,
    cached_input: 0,
    output: 0,
  },
  [EmbeddingModels.openai.EmbeddingSmall3]: {
    input: 0.02,
    cached_input: 0,
    output: 0,
  },
};
