/**
 * Meta Model API pricing (USD per 1M tokens)
 * Source: Meta Model API docs — https://api.meta.ai
 * New accounts start with $20 in free credits.
 */
export const MetaTextPricing: Record<string, { input: number; output: number; cached_input?: number }> = {
  "muse-spark-1.1": { input: 1.25, output: 4.25, cached_input: 0.15 },
};

// Web search grounding is billed per 1,000 search queries ($2.50/1,000),
// not per-token, so it isn't represented in the per-token pricing map above.
export const MetaWebSearchPricingPer1000Queries = 2.5;
