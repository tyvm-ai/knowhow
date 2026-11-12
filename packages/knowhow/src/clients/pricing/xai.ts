/**
 * xAI model IDs, pricing, and catalog.
 * Single source of truth for all xAI/Grok models.
 */
import { completions, images, videos, audios, ModelCatalogEntry, ModelPricing } from "./types";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const XaiModels = {
  Grok4_7: "grok-4.7",
  Grok4_6: "grok-4.6",
  Grok4_3: "grok-4.3",
  Grok_4_20_Reasoning: "grok-4.20-0309-reasoning",
  Grok_4_20_NonReasoning: "grok-4.20-0309-non-reasoning",
  Grok_4_20_MultiAgent: "grok-4.20-multi-agent-0309",
  Grok4_5: "grok-4.5",
  Grok4_1_Fast_Reasoning: "grok-4-1-fast-reasoning",
  Grok4_1_Fast_NonReasoning: "grok-4-1-fast-non-reasoning",
  GrokBuild: "grok-build-0.1",
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
  GrokImagineImage2: "grok-imagine-image-2.0",
  GrokImagineImage: "grok-imagine-image",
  GrokImagineImageQuality: "grok-imagine-image-quality",
  GrokImagineImagePro: "grok-imagine-image-pro",
  GrokImagineVideo1_5: "grok-imagine-video-1.5",
  GrokImagineVideo1_5Lite: "grok-imagine-video-1.5-lite",
  GrokImagineVideo: "grok-imagine-video",
  Grok2Image1212: "grok-2-image-1212",
} as const;

// ─── Modality arrays ──────────────────────────────────────────────────────────

export const XaiTextModels: string[] = [
  XaiModels.Grok4_7, XaiModels.Grok4_6, XaiModels.Grok4_3,
  XaiModels.Grok_4_20_Reasoning, XaiModels.Grok_4_20_NonReasoning,
  XaiModels.Grok_4_20_MultiAgent,
  XaiModels.Grok4_1_Fast_Reasoning, XaiModels.Grok4_1_Fast_NonReasoning,
  XaiModels.Grok4_5,
  XaiModels.GrokBuild, XaiModels.GrokCodeFast, XaiModels.Grok4,
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
// Grok 4.7, Grok 4.6, Grok 4.3, Grok 4.20 multi-agent, and grok-3-mini variants support reasoning_effort
export const XaiReasoningModels: string[] = [
  XaiModels.Grok4_7,
  XaiModels.Grok4_6,
  XaiModels.Grok4_3,
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
export const XaiImageModels: string[] = [
  XaiModels.GrokImagineImage2, XaiModels.GrokImagineImage,
  // Deprecated (still resolve via xAI redirects, except grok-2-image-1212)
  XaiModels.GrokImagineImageQuality, XaiModels.GrokImagineImagePro, XaiModels.Grok2Image1212,
];
export const XaiVideoModels: string[] = [
  XaiModels.GrokImagineVideo1_5, XaiModels.GrokImagineVideo1_5Lite, XaiModels.GrokImagineVideo,
];

/**
 * xAI text-to-speech (POST /v1/tts). The API has no `model` parameter, so "grok-tts" is a catalog-only id that
 * lets the speech endpoint be selected/priced like any other audio model. Kept out of `XaiModels` so it does
 * not leak into the completion model lists.
 */
export const XaiTTSModelId = "grok-tts";
export const XaiTTSModels: string[] = [XaiTTSModelId];

/** Video models that support the 1.5-generation features (native 1080p, last_frame, keyframes, lip-synced audio). */
export const XaiVideo15Models: string[] = [XaiModels.GrokImagineVideo1_5, XaiModels.GrokImagineVideo1_5Lite];

/**
 * grok-imagine-image-2.0 per-image prices by quality × resolution (USD).
 * Source: GET /v1/image-generation-models (price_per_image, 1e-10 USD ticks).
 * `auto` (default) serves `low` for generation and `medium` for edits.
 */
export const XaiImage2TierPricing: Record<"low" | "medium", Record<"1k" | "1.5k" | "2k", number>> = {
  low:    { "1k": 0.04, "1.5k": 0.05, "2k": 0.06 },
  medium: { "1k": 0.06, "1.5k": 0.07, "2k": 0.08 },
};

// ─── Pricing (USD per 1M tokens / per-image / per-second) ────────────────────

// Retired May 15, 2026: xAI still resolves these slugs but serves them with
// grok-4.3 (reasoning → `low` effort, non-reasoning → `none`) and bills at
// grok-4.3 rates (verified via usage.cost_in_usd_ticks). We keep calling the
// slug (no client-side routesTo) so xAI applies the matching reasoning effort.
const RETIRED_TO_GROK_4_3: ModelPricing = {
  input: 1.25, input_gt_200k: 2.5, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.5, output_gt_200k: 5.0,
  deprecated: true, deprecationDate: "2026-05-15", replacedBy: "grok-4.3",
};
const retired = (extra: Partial<ModelPricing> = {}): ModelPricing => ({ ...RETIRED_TO_GROK_4_3, ...extra });

export const XaiTextPricing: Record<string, ModelPricing> = {
  [XaiModels.Grok4_7]:                    { input: 2.0, input_gt_200k: 4.0, cache_hit: 0.50, cache_hit_gt_200k: 1.0, output: 6.0, output_gt_200k: 12.0, reasoningLevels: ["low", "medium", "high", "xhigh"] },
  [XaiModels.Grok4_6]:                    { input: 2.0, input_gt_200k: 4.0, cache_hit: 0.50, cache_hit_gt_200k: 1.0, output: 6.0, output_gt_200k: 12.0, reasoningLevels: ["low", "medium", "high", "xhigh"] },
  [XaiModels.Grok4_3]:                    { input: 1.25, input_gt_200k: 2.5, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.5, output_gt_200k: 5.0, reasoningLevels: ["none", "low", "medium", "high", "xhigh"] },
  [XaiModels.Grok_4_20_Reasoning]:       { input: 1.25, input_gt_200k: 2.5, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.5, output_gt_200k: 5.0, useResponsesApi: true },
  [XaiModels.Grok_4_20_NonReasoning]:    { input: 1.25, input_gt_200k: 2.5, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.5, output_gt_200k: 5.0, useResponsesApi: true },
  [XaiModels.Grok_4_20_MultiAgent]:      { input: 1.25, input_gt_200k: 2.5, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.5, output_gt_200k: 5.0, reasoningLevels: ["low", "medium", "high", "xhigh"], useResponsesApi: true },
  // Retired 2026-05-15 → billed as grok-4.3 (was $0.20 in / $0.05 cached / $0.50 out)
  [XaiModels.Grok4_1_Fast_Reasoning]:    retired({ useResponsesApi: true }),
  [XaiModels.Grok4_1_Fast_NonReasoning]: retired({ useResponsesApi: true }),
  [XaiModels.Grok4_5]:                   { input: 2.0, input_gt_200k: 4.0, cache_hit: 0.30, cache_hit_gt_200k: 0.60, output: 6.0, output_gt_200k: 12.0 },
  [XaiModels.GrokBuild]:                 { input: 1.0, input_gt_200k: 2.0, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.0, output_gt_200k: 4.0 },
  // grok-code-fast-1 is now an alias of grok-build-0.1 (same price) — safe to route client-side
  [XaiModels.GrokCodeFast]:              { input: 1.0, input_gt_200k: 2.0, cache_hit: 0.20, cache_hit_gt_200k: 0.40, output: 2.0, output_gt_200k: 4.0, deprecated: true, deprecationDate: "2026-05-15", replacedBy: "grok-build-0.1", routesTo: "grok-build-0.1" },
  // Retired → billed as grok-4.3 (was grok-4-0709 $3/$15, grok-3 $3/$15, grok-3-mini $0.30/$0.50,
  // grok-3-fast $5/$25, grok-3-mini-fast $0.60/$4)
  [XaiModels.Grok4]:                     retired(),
  [XaiModels.Grok3Beta]:                 retired(),
  [XaiModels.Grok3MiniBeta]:             retired(),
  [XaiModels.Grok3FastBeta]:             retired(),
  [XaiModels.Grok3MiniFastBeta]:         retired(),
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
  [XaiModels.Grok4_1_Fast]:         { input: 0.2, output: 0.5, deprecated: true, replacedBy: "grok-4.3" },
  [XaiModels.Grok4Fast]:            { input: 0.2, output: 0.5, deprecated: true, replacedBy: "grok-4.3" },
  [XaiModels.Grok4FastNonReasoning]:retired(),
};

export const XaiImagePricing: Record<string, ModelPricing> = {
  // Default (auto → low, 1k). Quality/resolution tiers in XaiImage2TierPricing.
  [XaiModels.GrokImagineImage2]:   { image_generation: 0.04 },
  // Superseded (still served) by grok-imagine-image-2.0, which is pricier ($0.04+) but adds quality tiers.
  [XaiModels.GrokImagineImage]:    { image_generation: 0.02, replacedBy: XaiModels.GrokImagineImage2 },
  // Retired 2026-11-02: xAI serves it as grok-imagine-image-2.0 at quality "low"
  [XaiModels.GrokImagineImageQuality]: { image_generation: 0.04, deprecated: true, deprecationDate: "2026-11-02", replacedBy: XaiModels.GrokImagineImage2 },
  // Retired 2026-05-15 → grok-imagine-image-quality → grok-imagine-image-2.0 (low). Was $0.07.
  [XaiModels.GrokImagineImagePro]:     { image_generation: 0.04, deprecated: true, deprecationDate: "2026-05-15", replacedBy: XaiModels.GrokImagineImage2 },
  // Removed 2026-02-24 — returns 404 "no longer accessible"
  [XaiModels.Grok2Image1212]:      { image_generation: 0.07, deprecated: true, deprecationDate: "2026-02-24", replacedBy: XaiModels.GrokImagineImage },
};

export const XaiVideoPricing: Record<string, ModelPricing> = {
  [XaiModels.GrokImagineVideo1_5]:     { video_generation: 0.08 },
  [XaiModels.GrokImagineVideo1_5Lite]: { video_generation: 0.02 },
  // Superseded by grok-imagine-video-1.5 for generation (still served). NOTE: it is the only xAI video
  // model that supports video_url editing (/v1/videos/edits), so editing callers must not follow this link.
  [XaiModels.GrokImagineVideo]:        { video_generation: 0.05, replacedBy: XaiModels.GrokImagineVideo1_5 },
};

/** Text to Speech: $15.00 / 1M characters (docs.x.ai/developers/pricing, checked 2026-11-13). `input` is per 1M chars. */
export const XaiTTSPricing: Record<string, ModelPricing> = {
  [XaiTTSModelId]: { input: 15.0, output: 0 },
};

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Metadata (deprecated, useResponsesApi) is read directly from XaiTextPricing entries.

export const XAI_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...completions([...XaiTextModels, ...XaiDeprecatedTextModels], "xai", XaiTextPricing),
  ...images(XaiImageModels, "xai", XaiImagePricing),
  ...videos(XaiVideoModels, "xai", XaiVideoPricing),
  ...audios(XaiTTSModels, "xai", XaiTTSPricing),
];
