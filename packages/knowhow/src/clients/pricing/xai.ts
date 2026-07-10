/**
 * xAI model IDs, pricing, and catalog.
 * Single source of truth for all xAI/Grok models.
 */
import { completions, images, videos, ModelCatalogEntry, ModelPricing } from "./types";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const XaiModels = {
  Grok_4_20_Reasoning: "grok-4.20-0309-reasoning",
  Grok_4_20_NonReasoning: "grok-4.20-0309-non-reasoning",
  Grok_4_20_MultiAgent: "grok-4.20-multi-agent-0309",
  Grok4_5: "grok-4.5",
  Grok4_1_Fast_Reasoning: "grok-4-1-fast-reasoning",
  Grok4_1_Fast_NonReasoning: "grok-4-1-fast-non-reasoning",
  GrokCodeFast: "grok-code-fast-1",
  Grok4: "grok-4-0709",
  Grok3Beta: "grok-3-beta",
  Grok3MiniBeta: "grok-3-mini-beta",
  Grok3FastBeta: "grok-3-fast-beta",
  Grok3MiniFastBeta: "grok-3-mini-fast-beta",
  // Deprecated alias IDs used by models.dev (latest aliases and older beta names)
  Grok2Latest: "grok-2-latest",
  Grok2VisionLatest: "grok-2-vision-latest",
  Grok3Latest: "grok-3-latest",
  Grok3FastLatest: "grok-3-fast-latest",
  Grok3MiniLatest: "grok-3-mini-latest",
  Grok3MiniFastLatest: "grok-3-mini-fast-latest",
  GrokBeta: "grok-beta",
  GrokVisionBeta: "grok-vision-beta",
  // grok-4-1-fast variants (aliases for grok-4-1-fast-reasoning/non-reasoning)
  Grok4_1_Fast: "grok-4-1-fast",
  Grok4Fast: "grok-4-fast",
  Grok4FastNonReasoning: "grok-4-fast-non-reasoning",
  Grok21212: "grok-2-1212",
  Grok2Vision1212: "grok-2-vision-1212",
  GrokImagineImage: "grok-imagine-image",
  GrokImagineVideo: "grok-imagine-video",
  Grok2Image1212: "grok-2-image-1212",
} as const;

// ─── Modality arrays ──────────────────────────────────────────────────────────

export const XaiTextModels: string[] = [
  XaiModels.Grok_4_20_Reasoning, XaiModels.Grok_4_20_NonReasoning,
  XaiModels.Grok_4_20_MultiAgent,
  XaiModels.Grok4_1_Fast_Reasoning, XaiModels.Grok4_1_Fast_NonReasoning,
  XaiModels.Grok4_5,
  XaiModels.GrokCodeFast, XaiModels.Grok4,
  XaiModels.Grok3Beta, XaiModels.Grok3MiniBeta, XaiModels.Grok3FastBeta, XaiModels.Grok3MiniFastBeta,
];

// Models that require the Responses API (/v1/responses) instead of /v1/chat/completions
// The xAI reasoning variants and multi-agent model use the Responses API
export const XaiResponsesOnlyModels: string[] = [
  XaiModels.Grok_4_20_Reasoning,
  XaiModels.Grok_4_20_NonReasoning,
  XaiModels.Grok_4_20_MultiAgent,
  XaiModels.Grok4_1_Fast_Reasoning,
  XaiModels.Grok4_1_Fast_NonReasoning,
];

// Models that support the reasoning_effort parameter
// grok-3-mini variants support reasoning_effort; grok-3-beta, grok-4 etc. do NOT
export const XaiReasoningModels: string[] = [
  XaiModels.Grok_4_20_MultiAgent,
  XaiModels.Grok3MiniBeta,
  XaiModels.Grok3MiniFastBeta,
];

// Deprecated xAI models — "Model not found" (400) when called
export const XaiDeprecatedTextModels: string[] = [
  XaiModels.Grok21212, XaiModels.Grok2Vision1212,
  // Alias IDs from models.dev that map to deprecated/versioned models
  XaiModels.Grok2Latest, XaiModels.Grok2VisionLatest,
  XaiModels.Grok3Latest, XaiModels.Grok3FastLatest,
  XaiModels.Grok3MiniLatest, XaiModels.Grok3MiniFastLatest,
  XaiModels.GrokBeta, XaiModels.GrokVisionBeta,
  XaiModels.Grok4_1_Fast, XaiModels.Grok4Fast, XaiModels.Grok4FastNonReasoning,
];
export const XaiImageModels: string[] = [XaiModels.GrokImagineImage, XaiModels.Grok2Image1212];
export const XaiVideoModels: string[] = [XaiModels.GrokImagineVideo];

// ─── Pricing (USD per 1M tokens / per-image / per-second) ────────────────────

export const XaiTextPricing: Record<string, ModelPricing> = {
  [XaiModels.Grok_4_20_Reasoning]:       { input: 2.0, cache_hit: 0.20, output: 6.0, useResponsesApi: true },
  [XaiModels.Grok_4_20_NonReasoning]:    { input: 2.0, cache_hit: 0.20, output: 6.0, useResponsesApi: true },
  [XaiModels.Grok_4_20_MultiAgent]:      { input: 2.0, cache_hit: 0.20, output: 6.0, reasoningLevels: ["low", "medium", "high", "xhigh"], useResponsesApi: true },
  [XaiModels.Grok4_1_Fast_Reasoning]:    { input: 0.2, cache_hit: 0.05, output: 0.5, useResponsesApi: true },
  [XaiModels.Grok4_1_Fast_NonReasoning]: { input: 0.2, cache_hit: 0.05, output: 0.5, useResponsesApi: true },
  [XaiModels.Grok4_5]:                   { input: 2.0, cache_hit: 0.50, output: 6.0 },
  [XaiModels.GrokCodeFast]:              { input: 0.2, cache_hit: 0.02, output: 1.5 },
  [XaiModels.Grok4]:                     { input: 3.0, output: 15.0 },
  [XaiModels.Grok3Beta]:                 { input: 3.0, output: 15.0 },
  [XaiModels.Grok3MiniBeta]:             { input: 0.3, output: 0.5 },
  [XaiModels.Grok3FastBeta]:             { input: 5.0, output: 25.0 },
  [XaiModels.Grok3MiniFastBeta]:         { input: 0.6, output: 4.0 },
  [XaiModels.Grok21212]:       { input: 2.0, output: 10.0, deprecated: true },
  [XaiModels.Grok2Vision1212]: { input: 2.0, output: 10.0, deprecated: true },
  // Deprecated alias IDs (models.dev uses these; they map to versioned/beta models above)
  [XaiModels.Grok2Latest]:          { input: 2.0, output: 10.0, deprecated: true },
  [XaiModels.Grok2VisionLatest]:    { input: 2.0, output: 10.0, deprecated: true },
  [XaiModels.Grok3Latest]:          { input: 3.0, output: 15.0, deprecated: true },
  [XaiModels.Grok3FastLatest]:      { input: 5.0, output: 25.0, deprecated: true },
  [XaiModels.Grok3MiniLatest]:      { input: 0.3, output: 0.5,  deprecated: true },
  [XaiModels.Grok3MiniFastLatest]:  { input: 0.6, output: 4.0,  deprecated: true },
  [XaiModels.GrokBeta]:             { input: 5.0, output: 15.0, deprecated: true },
  [XaiModels.GrokVisionBeta]:       { input: 5.0, output: 15.0, deprecated: true },
  // grok-4-1-fast / grok-4-fast aliases — deprecated in favor of versioned reasoning/non-reasoning variants
  [XaiModels.Grok4_1_Fast]:         { input: 0.2, output: 0.5, deprecated: true },
  [XaiModels.Grok4Fast]:            { input: 0.2, output: 0.5, deprecated: true },
  [XaiModels.Grok4FastNonReasoning]:{ input: 0.2, output: 0.5, deprecated: true },
};

export const XaiImagePricing: Record<string, ModelPricing> = {
  "grok-imagine-image-pro":        { image_generation: 0.07 },
  [XaiModels.GrokImagineImage]:    { image_generation: 0.02 },
  [XaiModels.Grok2Image1212]:      { image_generation: 0.07 },
};

export const XaiVideoPricing: Record<string, ModelPricing> = {
  [XaiModels.GrokImagineVideo]: { video_generation: 0.05 },
};

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Metadata (deprecated, useResponsesApi) is read directly from XaiTextPricing entries.

export const XAI_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...completions([...XaiTextModels, ...XaiDeprecatedTextModels], "xai", XaiTextPricing),
  ...images(XaiImageModels, "xai", XaiImagePricing),
  ...videos(XaiVideoModels, "xai", XaiVideoPricing),
];
