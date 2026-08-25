/**
 * A historical record of a model's pricing at a point in time.
 * Use this to track price changes over time.
 */
export interface PricingChangelogEntry {
  /** ISO date string when this pricing became effective (e.g. "2025-04-01") */
  date: string;
  /** Optional human-readable note about the change (e.g. "Promotional pricing announcement") */
  note?: string;
  /** The pricing values that were in effect from this date */
  pricing: Omit<ModelPricing, "deprecated" | "deprecationDate" | "limitedAvailability" | "replacedBy" | "reasoningLevels" | "useResponsesApi" | "changelog">;
}

export type ModelType =
  | "completion"
  | "embedding"
  | "image"
  | "audio"
  | "video"
  | "transaction"
  | "live";

export interface ModelPricing {
  input?: number;
  output?: number;
  cached_input?: number;
  cache_write?: number;
  cache_hit?: number;
  input_audio?: number;
  output_audio?: number;
  input_gt_200k?: number;
  output_gt_200k?: number;
  image_generation?: number;
  image_generation_per_1m_tokens?: number;
  video_generation?: number;
  output_image_per_1m_tokens?: number;
  // Optional metadata — when set on a pricing entry, the catalog picks them up automatically
  deprecated?: boolean;
  deprecationDate?: string;
  limitedAvailability?: boolean;
  replacedBy?: string;
  /** Supported reasoning effort levels for this model (ordered low→high). If set, effort will be clamped to these values. */
  reasoningLevels?: string[];
  /** If true, this model must be called via the Responses API (/v1/responses) instead of /v1/chat/completions */
  useResponsesApi?: boolean;
  /** Optional changelog of historical pricing entries, ordered from oldest to newest */
  changelog?: PricingChangelogEntry[];
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  type: ModelType;
  pricing: ModelPricing;
  deprecated?: boolean;
  deprecationDate?: string;
  /** Model exists but is not generally available (e.g. Live API only, limited access, or returns empty responses) */
  limitedAvailability?: boolean;
  /** Recommended replacement model ID when this model is deprecated */
  replacedBy?: string;
}

// ─── Bulk catalog helpers ─────────────────────────────────────────────────────

export interface DeprecationOptions {
  deprecated?: boolean;
  deprecationDate?: string;
  limitedAvailability?: boolean;
  replacedBy?: string;
}

function makeEntries(
  type: ModelType,
  ids: string[],
  provider: string,
  pricing: Record<string, ModelPricing>,
  deprecation?: DeprecationOptions
): ModelCatalogEntry[] {
  return ids.map((id) => {
    const p = pricing[id] ?? {};
    // Explicit dep options take precedence; fall back to metadata embedded in the pricing entry
    const deprecated       = deprecation?.deprecated       ?? p.deprecated;
    const deprecationDate  = deprecation?.deprecationDate  ?? p.deprecationDate;
    const limitedAvailability = deprecation?.limitedAvailability ?? p.limitedAvailability;
    const replacedBy       = deprecation?.replacedBy       ?? p.replacedBy;
    // Strip metadata fields before storing as pricing
    const { deprecated: _d, deprecationDate: _dd, limitedAvailability: _la, replacedBy: _rb, reasoningLevels: _rl, useResponsesApi: _ura, ...pricingOnly } = p;
    return {
      id,
      provider,
      type,
      pricing: { input: 0, output: 0, ...pricingOnly },
      deprecated,
      deprecationDate,
      limitedAvailability,
      replacedBy,
    };
  });
}

export const completions  = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("completion",   ids, provider, pricing, dep);
export const embeddings   = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("embedding",    ids, provider, pricing, dep);
export const images       = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("image",        ids, provider, pricing, dep);
export const videos       = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("video",        ids, provider, pricing, dep);
export const audios       = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("audio",        ids, provider, pricing, dep);
export const transactions = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("transaction",  ids, provider, pricing, dep);
export const liveApi      = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("live",         ids, provider, pricing, dep);

// ─── Single-entry helpers (for deprecated/special cases) ─────────────────────

export function completion(
  id: string,
  provider: string,
  pricing: Partial<ModelPricing> = {},
  deprecation?: DeprecationOptions
): ModelCatalogEntry {
  return {
    id, provider, type: "completion",
    pricing: { input: 0, output: 0, ...pricing },
    deprecated: deprecation?.deprecated,
    deprecationDate: deprecation?.deprecationDate,
    limitedAvailability: deprecation?.limitedAvailability,
    replacedBy: deprecation?.replacedBy,
  };
}
