/**
 * Price-aware compaction policy.
 *
 * Every agent request re-reads the whole conversation (from the prompt cache
 * when it's warm). Compacting costs a one-off fee F (summary output + writing
 * the new prefix) plus reading the current context once, and afterwards each
 * request re-reads ~C0 tokens instead of C.
 *
 * Over a cycle where context starts at C0, grows g tokens per request and is
 * compacted at Cmax, the context cost per request is minimised at
 *
 *   Cmax* ≈ C0 + √(2·g·(F/r + C0))
 *
 * where r is the per-token cache-read price. The optimum is flat (±40% in
 * Cmax costs <10%), so rough estimates of g and C0 are good enough.
 *
 * Separately, when the prompt cache is about to expire while the agent is
 * blocked (e.g. on a long tool call), compacting *while the cache is still
 * warm* is far cheaper than letting the next request re-write the whole
 * conversation: see shouldCompactBeforeCacheExpiry().
 *
 * Cache lifetimes come from the catalog (ModelInfo.promptCache):
 *  - explicit TTLs (Anthropic 5m/1h, OpenAI GPT-5.6+ 30m): the agent knows
 *    when the cache expires and arms the pre-expiry check;
 *  - best-effort caches (Gemini, xAI, OpenAI ≤ 5.5): no guaranteed lifetime,
 *    no expiry check.
 * A thread keeps one TTL for its whole life (re-sending a cached prefix with a
 * different TTL re-writes all of it). Anthropic threads start on 5m; once a
 * task has run 5 minutes the agent moves to 1h *at a compaction* (the summary
 * is generated on the warm 5m cache and the new thread is written at 1h),
 * or switches in place when the context is too small for that to pay off:
 * see chooseLongTtlSwitch().
 */
import { AnthropicTextPricing } from "../../clients/pricing/anthropic";
import { OpenAiTextPricing } from "../../clients/pricing/openai";
import { GeminiPricing } from "../../clients/pricing/google";
import { XaiTextPricing } from "../../clients/pricing/xai";
import { FireworksTextPricing } from "../../clients/pricing/fireworks";
import { MetaTextPricing } from "../../clients/pricing/meta";
import {
  getModelInfo,
  promptCacheTtl,
} from "../../clients/pricing/modelInfo";
import type {
  ModelPricing,
  PromptCacheInfo,
} from "../../clients/pricing/types";

/** Output tokens a compaction typically generates (summary + thinking). */
export const COMPACTION_OUTPUT_TOKENS = 6_000;
/** Tokens written to cache for the new compacted prefix. */
export const COMPACTION_WRITE_TOKENS = 10_000;
/** Tokens a summary adds on top of the base prompt (system + tools + task). */
export const SUMMARY_TOKENS = 4_000;
/** Growth per request assumed until enough requests have been observed. */
export const DEFAULT_GROWTH_PER_REQUEST = 5_000;

/**
 * Threads started this long after the task starts use the model's long cache
 * TTL (Anthropic 1h); the switch from a short-TTL thread happens at a
 * compaction (see chooseLongTtlSwitch).
 */
export const LONG_TTL_AFTER_MS = 5 * 60_000;

/** Per-token prices relevant to re-sending context. */
export interface ContextPrices {
  input: number;
  /** Price of a cached-prefix read (input price when the model can't cache). */
  read: number;
  /** Price of writing the prefix to a short-TTL cache. */
  write: number;
  /** Price of writing the prefix to a long-TTL (1h) cache. */
  writeLong: number;
  output: number;
}

const ALL_TEXT_PRICING: Record<string, ModelPricing> = {
  ...OpenAiTextPricing,
  ...AnthropicTextPricing,
  ...GeminiPricing,
  ...XaiTextPricing,
  ...FireworksTextPricing,
  ...MetaTextPricing,
};

/** Model id plus every suffix after a "provider/" prefix (knowhow proxy ids). */
function modelCandidates(model: string): string[] {
  const parts = model.split("/");
  return parts.map((_, i) => parts.slice(i).join("/"));
}

/** Prompt-cache policy for a model as served by `provider` (catalog ModelInfo). */
export function getPromptCacheInfo(
  model: string,
  provider?: string
): PromptCacheInfo | undefined {
  return getModelInfo(model, provider).info.promptCache;
}

export function getContextPrices(
  model: string,
  provider?: string
): ContextPrices | undefined {
  const pricing = modelCandidates(model)
    .map((m) => ALL_TEXT_PRICING[m])
    .find(Boolean);
  if (!pricing?.input || !pricing.output) return undefined;

  const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;
  const input = perToken(pricing.input);
  const read = perToken(pricing.cache_hit ?? pricing.cached_input ?? pricing.input);
  const cache = getPromptCacheInfo(model, provider);
  const shortTtl = promptCacheTtl(cache, false);
  const longTtl = promptCacheTtl(cache, true);
  const write = pricing.cache_write
    ? perToken(pricing.cache_write)
    : input * (shortTtl?.writeMultiplier ?? 1);
  // e.g. Anthropic bills 1h writes at 2× base input; no long TTL → same as short.
  const writeLong =
    longTtl && longTtl !== shortTtl ? input * longTtl.writeMultiplier : write;
  return { input, read, write, writeLong, output: perToken(pricing.output) };
}

/** One-off cost of compacting, excluding reading the current context. */
export function compactionFixedCost(prices: ContextPrices, longTtl = false): number {
  const write = longTtl ? prices.writeLong : prices.write;
  return prices.output * COMPACTION_OUTPUT_TOKENS + write * COMPACTION_WRITE_TOKENS;
}

export interface ThresholdInput {
  prices: ContextPrices;
  /** Context tokens left right after a compaction. */
  baseTokens: number;
  /** Observed context growth per request. */
  growthPerRequest: number;
  longTtl?: boolean;
}

/** Cmax* ≈ C0 + √(2·g·(F/r + C0)), never closer than 20k above C0. */
export function optimalCompactionThreshold({
  prices,
  baseTokens,
  growthPerRequest,
  longTtl,
}: ThresholdInput): number {
  const fixedInTokens = compactionFixedCost(prices, longTtl) / prices.read;
  const growth = Math.max(1_000, growthPerRequest);
  const optimum = baseTokens + Math.sqrt(2 * growth * (fixedInTokens + baseTokens));
  return Math.round(Math.max(optimum, baseTokens + 20_000));
}

/** Whether the model has a long TTL to move to (Anthropic 1h; not OpenAI 30m). */
export function hasLongTtl(cache: PromptCacheInfo | undefined): boolean {
  const long = promptCacheTtl(cache, true);
  return !!long && long !== promptCacheTtl(cache, false);
}

/**
 * Whether a thread starting `runTimeMs` into the task should use the long TTL:
 * only once the task has run past `afterMs` and the model has one.
 */
export function usesLongTtlCache(
  runTimeMs: number,
  cache?: PromptCacheInfo,
  afterMs = LONG_TTL_AFTER_MS
): boolean {
  return runTimeMs > afterMs && hasLongTtl(cache);
}

/**
 * How long the prompt cache written by a request is guaranteed to stay warm,
 * from that request. Undefined for best-effort caches (no guarantee, so no
 * pre-expiry compaction).
 */
export function promptCacheTtlMs(
  cache: PromptCacheInfo | undefined,
  longTtl: boolean
): number | undefined {
  return promptCacheTtl(cache, longTtl)?.ms;
}

/**
 * When to start a pre-expiry compaction, measured from the last request. The
 * lead time leaves room for the (up to two) compaction calls to *start* while
 * the cache is still warm: 5m TTL → 3m, 1h TTL → 51m.
 */
export function cacheExpiryCheckDelayMs(ttlMs: number): number {
  return ttlMs - Math.max(2 * 60_000, Math.round(ttlMs * 0.15));
}

export interface ExpiryDecisionInput {
  prices: ContextPrices;
  contextTokens: number;
  baseTokens: number;
  /** Compaction calls that read the full context (1 if the task breakdown is cached). */
  compactionCalls: number;
  longTtl: boolean;
}

/**
 * Compact now (cache warm) vs. let the cache expire: after expiry the next
 * request re-writes all C tokens; compacting now reads C per compaction call,
 * pays F, then writes only the ~C0 compacted prefix.
 */
export function shouldCompactBeforeCacheExpiry({
  prices,
  contextTokens,
  baseTokens,
  compactionCalls,
  longTtl,
}: ExpiryDecisionInput): boolean {
  const write = longTtl ? prices.writeLong : prices.write;
  const missCost = write * contextTokens;
  const compactCost =
    prices.output * COMPACTION_OUTPUT_TOKENS +
    compactionCalls * prices.read * contextTokens +
    write * baseTokens;
  return contextTokens > baseTokens * 1.5 && missCost > compactCost;
}

export interface TtlSwitchInput {
  prices: ContextPrices;
  contextTokens: number;
  baseTokens: number;
  /** Compaction calls that read the full context (1 if the task breakdown is cached). */
  compactionCalls: number;
}

/**
 * Moving a thread from the short to the long TTL. Re-sending the thread with
 * the long TTL re-writes all C tokens at the long-write price; compacting on
 * the still-warm short cache reads C per compaction call, pays the summary
 * output, and writes only the ~C0 compacted prefix at the long price.
 */
export function chooseLongTtlSwitch({
  prices,
  contextTokens,
  baseTokens,
  compactionCalls,
}: TtlSwitchInput): "compact" | "switch" {
  const rewriteCost = prices.writeLong * contextTokens;
  const compactCost =
    prices.output * COMPACTION_OUTPUT_TOKENS +
    compactionCalls * prices.read * contextTokens +
    prices.writeLong * baseTokens;
  return contextTokens > baseTokens * 1.5 && compactCost < rewriteCost
    ? "compact"
    : "switch";
}
