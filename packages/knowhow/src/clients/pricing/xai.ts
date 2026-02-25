import { Models } from "../../types";

export const XaiTextPricing = {
  [Models.xai.Grok4_1_Fast_NonReasoning]: {
    input: 0.2,
    cache_hit: 0.05,
    output: 0.5,
  },
  [Models.xai.Grok4_1_Fast_Reasoning]: {
    input: 0.2,
    cache_hit: 0.05,
    output: 0.5,
  },
  [Models.xai.GrokCodeFast]: {
    input: 0.2,
    cache_hit: 0.02,
    output: 1.5,
  },
  [Models.xai.Grok4]: {
    input: 3.0,
    output: 15.0,
  },
  [Models.xai.Grok3Beta]: {
    input: 3.0,
    output: 15.0,
  },
  [Models.xai.Grok3MiniBeta]: {
    input: 0.3,
    output: 0.5,
  },
  [Models.xai.Grok3FastBeta]: {
    input: 5.0,
    output: 25.0,
  },
  [Models.xai.Grok3MiniFastBeta]: {
    input: 0.6,
    output: 4.0,
  },
  [Models.xai.Grok21212]: {
    input: 2.0,
    output: 10.0,
  },
  [Models.xai.Grok2Vision1212]: {
    input: 2.0,
    output: 10.0,
    image_input: 2.0,
  },
};

// Image generation pricing: per image
// Based on https://docs.x.ai/developers/models
export const XaiImagePricing = {
  "grok-imagine-image-pro": 0.07,
  "grok-imagine-image": 0.02,
  "grok-2-image-1212": 0.07,
};

// Video generation pricing: $0.05 per second
// Based on https://docs.x.ai/developers/models
export const XaiVideoPricing = {
  "grok-imagine-video": 0.05, // per second
};
