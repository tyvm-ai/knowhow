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
  pricing: Omit<ModelPricing, "deprecated" | "deprecationDate" | "limitedAvailability" | "replacedBy" | "routesTo" | "routesToDate" | "reasoningLevels" | "useResponsesApi" | "changelog" | "info">;
}

// ─── Model info (capabilities) ────────────────────────────────────────────────

/** One prompt-cache lifetime a provider lets callers pick. */
export interface PromptCacheTtl {
  /** Provider's name for it, e.g. "5m", "1h", "30m", "12h". */
  id: string;
  /** Minimum lifetime in ms (renewed on read where `readsRefreshTtl`). */
  ms: number;
  /** Cache-write price as a multiple of the base input price. */
  writeMultiplier: number;
}

export interface PromptCacheInfo {
  /**
   * - "explicit":  the provider guarantees a minimum lifetime per TTL
   *   (Anthropic cache_control.ttl, OpenAI GPT-5.6+ prompt_cache_options.ttl).
   * - "automatic": best-effort caching, no lifetime guarantee, entries may be
   *   evicted at any time (Gemini implicit caching, xAI, OpenAI ≤ GPT-5.5).
   * - "none":      no prompt caching.
   */
  mode: "explicit" | "automatic" | "none";
  /** Selectable lifetimes; the first is the provider default. Explicit mode only. */
  ttls?: PromptCacheTtl[];
  /**
   * TTL id agents move long-running tasks to (at a compaction, since changing
   * the TTL of an existing prefix re-writes it). Unset = stay on the default.
   */
  longTtl?: string;
  /** A cache read renews the lifetime. */
  readsRefreshTtl?: boolean;
  /** Re-sending a cached prefix with a different TTL re-writes all of it. */
  ttlChangeRewrites?: boolean;
  /** How to pin requests to one cache server, if the provider supports it. */
  routingKey?: "prompt_cache_key" | "x-grok-conv-id";
}

/**
 * Extra, non-price facts about a model. Lives in the catalog next to
 * deprecation / reroute metadata so callers ask one place
 * (AIClient.getModelInfo) instead of a growing list of client methods.
 */
export interface ModelInfo {
  /** "none": no reasoning; "optional": can be turned off; "always": always-on (lowest level still thinks). */
  reasoning?: "none" | "optional" | "always";
  /** Supported reasoning effort levels (ordered low→high). */
  reasoningLevels?: string[];
  /** Signed reasoning blocks are bound to the exact prefix they were produced with. */
  preservedThinking?: boolean;
  /** Accepts deferred tools enabled mid-conversation (see clients/toolChanges). */
  toolAdditions?: boolean;
  /** Must be called via the OpenAI-style Responses API. */
  useResponsesApi?: boolean;
  promptCache?: PromptCacheInfo;
}

export type ModelType =
  | "completion"
  | "embedding"
  | "image"
  | "audio"
  | "video"
  | "decision"
  | "transaction"
  | "live";

export interface ModelPricing {
  input?: number;
  output?: number;
  cached_input?: number;
  cached_input_gt_200k?: number;
  cache_write?: number;
  cache_write_gt_200k?: number;
  cache_hit?: number;
  cache_hit_gt_200k?: number;
  input_audio?: number;
  output_audio?: number;
  input_gt_200k?: number;
  output_gt_200k?: number;
  /** Input-token threshold at which the long-context rates apply (defaults to 200K). */
  long_context_threshold?: number;
  image_generation?: number;
  image_generation_per_1m_tokens?: number;
  video_generation?: number;
  /** Video output billed per 1M tokens (e.g. Gemini Omni: tokens scale with seconds × resolution). */
  output_video_per_1m_tokens?: number;
  /** Flat per-request price for generated audio (e.g. Lyria: USD per song / clip). */
  audio_generation?: number;
  output_image_per_1m_tokens?: number;
  // Optional metadata — when set on a pricing entry, the catalog picks them up automatically
  deprecated?: boolean;
  deprecationDate?: string;
  limitedAvailability?: boolean;
  replacedBy?: string;
  /**
   * The provider transparently reroutes requests for this model to another
   * model (and bills at that model's rates). When set, AIClient sends requests
   * straight to the target so request shaping (e.g. thinking config) and cost
   * tracking match what the provider actually serves.
   */
  routesTo?: string;
  /** ISO date (YYYY-MM-DD) the reroute takes effect. Omit if already in effect. */
  routesToDate?: string;
  /** Supported reasoning effort levels for this model (ordered low→high). If set, effort will be clamped to these values. */
  reasoningLevels?: string[];
  /** If true, this model must be called via the Responses API (/v1/responses) instead of /v1/chat/completions */
  useResponsesApi?: boolean;
  /** Optional changelog of historical pricing entries, ordered from oldest to newest */
  changelog?: PricingChangelogEntry[];
  /** Capabilities for this model (merged over the provider defaults in the catalog). */
  info?: ModelInfo;
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
  /**
   * Recommended replacement model ID. Set when the model is deprecated, and also when it is merely
   * superseded by a newer model that is still served (not deprecated). Follow chains with
   * `resolveSuccessor` / `resolveNewestSuccessor` in ../deprecation.
   */
  replacedBy?: string;
  /** Model the provider reroutes requests to (see ModelPricing.routesTo) */
  routesTo?: string;
  /** ISO date the reroute takes effect (see ModelPricing.routesToDate) */
  routesToDate?: string;
  /** Capabilities: reasoning, prompt caching, tool additions, ... */
  info?: ModelInfo;
}

/** Shallow merge where nested promptCache objects merge too; undefined values never override. */
export function mergeModelInfo(...parts: (ModelInfo | undefined)[]): ModelInfo {
  const out: ModelInfo = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [key, value] of Object.entries(part)) {
      if (value === undefined) continue;
      if (key === "promptCache" && out.promptCache && value) {
        out.promptCache = { ...out.promptCache, ...(value as PromptCacheInfo) };
      } else {
        (out as any)[key] = value;
      }
    }
  }
  return out;
}

/**
 * Attach capabilities to a provider's catalog entries: provider defaults,
 * then per-model overrides, then whatever the pricing entry already carried.
 */
export function withModelInfo(
  entries: ModelCatalogEntry[],
  defaults: ModelInfo,
  perModel: Record<string, ModelInfo> = {}
): ModelCatalogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    info: mergeModelInfo(defaults, perModel[entry.id], entry.info),
  }));
}

// ─── Bulk catalog helpers ─────────────────────────────────────────────────────

export interface DeprecationOptions {
  deprecated?: boolean;
  deprecationDate?: string;
  limitedAvailability?: boolean;
  replacedBy?: string;
  routesTo?: string;
  routesToDate?: string;
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
    const routesTo         = deprecation?.routesTo         ?? p.routesTo;
    const routesToDate     = deprecation?.routesToDate     ?? p.routesToDate;
    // Strip metadata fields before storing as pricing
    const { deprecated: _d, deprecationDate: _dd, limitedAvailability: _la, replacedBy: _rb, routesTo: _rt, routesToDate: _rtd, reasoningLevels: _rl, useResponsesApi: _ura, info: _info, ...pricingOnly } = p;
    const info = mergeModelInfo(
      { reasoningLevels: p.reasoningLevels, useResponsesApi: p.useResponsesApi },
      p.info
    );
    return {
      id,
      provider,
      type,
      pricing: { input: 0, output: 0, ...pricingOnly },
      deprecated,
      deprecationDate,
      limitedAvailability,
      replacedBy,
      ...(routesTo ? { routesTo } : {}),
      ...(routesToDate ? { routesToDate } : {}),
      ...(Object.keys(info).length ? { info } : {}),
    };
  });
}

export const completions  = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("completion",   ids, provider, pricing, dep);
export const embeddings   = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("embedding",    ids, provider, pricing, dep);
export const images       = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("image",        ids, provider, pricing, dep);
export const videos       = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("video",        ids, provider, pricing, dep);
export const audios       = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("audio",        ids, provider, pricing, dep);
export const decisions    = (ids: string[], provider: string, pricing: Record<string, ModelPricing>, dep?: DeprecationOptions) => makeEntries("decision",     ids, provider, pricing, dep);
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
    ...(deprecation?.routesTo ? { routesTo: deprecation.routesTo } : {}),
    ...(deprecation?.routesToDate ? { routesToDate: deprecation.routesToDate } : {}),
  };
}
