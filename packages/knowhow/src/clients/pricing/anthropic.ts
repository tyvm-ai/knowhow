/**
 * Anthropic model IDs, pricing, and catalog.
 * Single source of truth for all Anthropic/Claude models.
 * Deprecation dates from: https://docs.anthropic.com/en/docs/about-claude/model-deprecations
 */
import { completions, ModelCatalogEntry, ModelPricing } from "./types";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const AnthropicModels = {
  // Active models
  Fable5:    "claude-fable-5",
  // Short aliases (without date suffix) — Anthropic resolves these to the latest
  // dated version. Pricing entries for the short aliases are added to the pricing
  // table below so cost tracking works regardless of whether the user specifies
  // the full dated name or the short alias.
  Sonnet4_5Short: "claude-sonnet-4-5",
  Haiku4_5Short:  "claude-haiku-4-5",
  Opus4_5Short:   "claude-opus-4-5",
  Sonnet5:   "claude-sonnet-5",
  Mythos5:   "claude-mythos-5",
  MythosPreview: "claude-mythos-preview",
  Opus4_8:   "claude-opus-4-8",
  Opus4_8Fast: "claude-opus-4-8-fast",
  Opus4_7:   "claude-opus-4-7",
  Opus4_6:   "claude-opus-4-6",
  Opus4_6Fast: "claude-opus-4-6-fast",
  Sonnet4_6: "claude-sonnet-4-6",
  Opus4_5:   "claude-opus-4-5-20251101",
  Opus4_1:   "claude-opus-4-1-20250805",
  Sonnet4_5: "claude-sonnet-4-5-20250929",
  Haiku4_5:  "claude-haiku-4-5-20251001",
  // Deprecated models (per Anthropic deprecation page)
  Opus4:     "claude-opus-4-20250514",   // deprecated 2026-04-14, retirement 2026-06-15
  Sonnet4:   "claude-sonnet-4-20250514", // deprecated 2026-04-14, retirement 2026-06-15
  Sonnet3_7: "claude-3-7-sonnet-20250219", // retired 2026-02-19
  Sonnet3_5: "claude-3-5-sonnet-20241022", // retired 2025-10-28
  Sonnet3_5_20240620: "claude-3-5-sonnet-20240620", // earlier version, retired
  Haiku3_5_Latest: "claude-3-5-haiku-latest", // alias → claude-3-5-haiku-20241022, retired
  Sonnet3:   "claude-3-sonnet-20240229", // retired
  // models.dev alias IDs (versioned as -0 suffix instead of date)
  Opus4_0:   "claude-opus-4-0",    // alias for claude-opus-4-20250514, deprecated
  Sonnet4_0: "claude-sonnet-4-0",  // alias for claude-sonnet-4-20250514, deprecated
  Haiku3_5:  "claude-3-5-haiku-20241022",  // retired 2026-02-19
  Opus3:     "claude-3-opus-20240229",   // retired 2026-01-05
  Haiku3:    "claude-3-haiku-20240307",  // retired 2026-04-20
} as const;

// ─── Active (non-deprecated) text models ──────────────────────────────────────

export const AnthropicTextModels: string[] = [
  AnthropicModels.Opus4_8,
  AnthropicModels.Fable5,
  AnthropicModels.Sonnet5,
  AnthropicModels.Opus4_7,
  AnthropicModels.Opus4_6,
  AnthropicModels.Sonnet4_6,
  AnthropicModels.Opus4_5,
  AnthropicModels.Opus4_1,
  AnthropicModels.Sonnet4_5,
  AnthropicModels.Haiku4_5,
];

// Models in our catalog but not yet publicly available
export const AnthropicLimitedAvailabilityModels: string[] = [
  AnthropicModels.Opus4_8Fast, // fast mode pricing
  AnthropicModels.Mythos5,     // invitation-only (Project Glasswing)
  AnthropicModels.MythosPreview, // invitation-only (defensive cybersecurity)
  AnthropicModels.Opus4_6Fast, // 404 – not publicly available yet
];

// ─── All models for catalog (active + limited + deprecated/retired) ───────────
// Deprecation/replacement metadata is embedded in AnthropicTextPricing entries.
const AnthropicAllModels: string[] = [
  ...AnthropicTextModels,
  ...AnthropicLimitedAvailabilityModels,
  // Deprecated (retirement 2026-06-15)
  AnthropicModels.Opus4,
  AnthropicModels.Sonnet4,
  // Retired — kept for historical cost tracking
  AnthropicModels.Sonnet3_7,
  AnthropicModels.Sonnet3_5,
  AnthropicModels.Sonnet3_5_20240620,
  AnthropicModels.Haiku3_5_Latest,
  AnthropicModels.Sonnet3,
  AnthropicModels.Opus4_0,
  AnthropicModels.Sonnet4_0,
  AnthropicModels.Haiku3_5,
  AnthropicModels.Opus3,
  AnthropicModels.Haiku3,
];

// ─── Pricing (USD per 1M tokens) ──────────────────────────────────────────────

export const AnthropicTextPricing: Record<string, ModelPricing> = {
  [AnthropicModels.Opus4_8]:   { input: 5.0,  cache_write: 6.25,   cache_hit: 0.5,  output: 25.0 },
  [AnthropicModels.Opus4_8Fast]: { input: 10.0, cache_write: 12.5,  cache_hit: 1.0,  output: 50.0, limitedAvailability: true },
  // Claude 5 generation (launched 2026-06-09)
  [AnthropicModels.Fable5]:    { input: 10.0, cache_write: 12.5,   cache_hit: 1.0,  output: 50.0 },
  [AnthropicModels.Sonnet5]:   { input: 3.0,  cache_write: 3.75,   cache_hit: 0.3,  output: 15.0 },
  [AnthropicModels.Mythos5]:   { input: 10.0, cache_write: 12.5,   cache_hit: 1.0,  output: 50.0, limitedAvailability: true },
  [AnthropicModels.MythosPreview]: { input: 10.0, cache_write: 12.5, cache_hit: 1.0, output: 50.0, limitedAvailability: true },
  [AnthropicModels.Opus4_7]:   { input: 5.0,  cache_write: 6.25,   cache_hit: 0.5,  output: 25.0 },
  [AnthropicModels.Opus4_6]:   { input: 5.0,  cache_write: 6.25,   cache_hit: 0.5,  output: 25.0 },
  [AnthropicModels.Opus4_6Fast]: { input: 30.0, cache_write: 37.5, cache_hit: 3.0,  output: 150.0, limitedAvailability: true },
  [AnthropicModels.Sonnet4_6]: { input: 3.0,  cache_write: 3.75,   cache_hit: 0.3,  output: 15.0 },
  [AnthropicModels.Opus4_5]:   { input: 5.0,  cache_write: 6.25,   cache_hit: 0.5,  output: 25.0 },
  [AnthropicModels.Opus4_1]:   { input: 15.0, cache_write: 18.75,  cache_hit: 1.5,  output: 75.0 },
  [AnthropicModels.Sonnet4_5]: { input: 3.0,  input_gt_200k: 6.0,  cache_write: 3.75, cache_hit: 0.3, output: 15.0, output_gt_200k: 22.5 },
  [AnthropicModels.Haiku4_5]:  { input: 1.0,  cache_write: 1.25,   cache_hit: 0.1,  output: 5.0 },
  // Short aliases — same pricing as their dated counterparts
  [AnthropicModels.Sonnet4_5Short]: { input: 3.0, input_gt_200k: 6.0, cache_write: 3.75, cache_hit: 0.3, output: 15.0, output_gt_200k: 22.5 },
  [AnthropicModels.Haiku4_5Short]:  { input: 1.0, cache_write: 1.25, cache_hit: 0.1, output: 5.0 },
  [AnthropicModels.Opus4_5Short]:   { input: 5.0, cache_write: 6.25, cache_hit: 0.5, output: 25.0 },
  // Deprecated — pricing retained for cost tracking
  [AnthropicModels.Opus4]:     { input: 15.0, cache_write: 18.75,  cache_hit: 1.5,  output: 75.0,  deprecated: true, deprecationDate: "2026-06-15" },
  [AnthropicModels.Sonnet4]:   { input: 3.0,  input_gt_200k: 6.0,  cache_write: 3.75, cache_hit: 0.3, output: 15.0, output_gt_200k: 22.5, deprecated: true, deprecationDate: "2026-06-15" },
  // Retired — pricing retained for cost tracking of historical usage
  [AnthropicModels.Sonnet3_7]: { input: 3.0,  cache_write: 3.75,   cache_hit: 0.3,  output: 15.0,  deprecated: true, deprecationDate: "2026-02-19" },
  [AnthropicModels.Sonnet3_5]: { input: 3.0,  cache_write: 3.75,   cache_hit: 0.3,  output: 15.0,  deprecated: true, deprecationDate: "2025-10-28" },
  [AnthropicModels.Sonnet3_5_20240620]: { input: 3.0, cache_write: 3.75, cache_hit: 0.3, output: 15.0, deprecated: true, deprecationDate: "2025-10-28" },
  [AnthropicModels.Haiku3_5_Latest]:   { input: 0.8, cache_write: 1.0,   cache_hit: 0.08, output: 4.0,  deprecated: true, deprecationDate: "2026-02-19" },
  [AnthropicModels.Sonnet3]:           { input: 3.0, cache_write: 3.75,  cache_hit: 0.3,  output: 15.0, deprecated: true },
  [AnthropicModels.Opus4_0]:           { input: 15.0, cache_write: 18.75, cache_hit: 1.5, output: 75.0, deprecated: true, deprecationDate: "2026-06-15" },
  [AnthropicModels.Sonnet4_0]:         { input: 3.0,  cache_write: 3.75,  cache_hit: 0.3,  output: 15.0, deprecated: true, deprecationDate: "2026-06-15" },
  [AnthropicModels.Haiku3_5]:  { input: 0.8,  cache_write: 1.0,    cache_hit: 0.08, output: 4.0,   deprecated: true, deprecationDate: "2026-02-19" },
  [AnthropicModels.Opus3]:     { input: 15.0, cache_write: 18.75,  cache_hit: 1.5,  output: 75.0,  deprecated: true, deprecationDate: "2026-01-05" },
  [AnthropicModels.Haiku3]:    { input: 0.25, cache_write: 0.3125, cache_hit: 0.025, output: 1.25, deprecated: true, deprecationDate: "2026-04-20" },
};

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Metadata (deprecated, deprecationDate, limitedAvailability) is read directly
// from the AnthropicTextPricing entries — no need for separate groups.

export const ANTHROPIC_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...completions(AnthropicAllModels, "anthropic", AnthropicTextPricing),
];
