/**
 * DeepSeek pricing (USD per 1M tokens)
 * Source: https://platform.deepseek.com/pricing
 */
export const DeepSeekTextPricing: Record<string, { input: number; output: number; cached_input?: number }> = {
  // DeepSeek V3 / deepseek-chat — updated 2026-04 (now routes to DeepSeek V3-0324)
  // Source: api-docs.deepseek.com/quick_start/pricing
  "deepseek-chat": { input: 0.28, output: 0.42, cached_input: 0.028 },
  // DeepSeek R1 / deepseek-reasoner — same unified pricing as V3
  // Source: api-docs.deepseek.com/quick_start/pricing (costgoat.com verification)
  "deepseek-reasoner": { input: 0.28, output: 0.42, cached_input: 0.028 },
  // DeepSeek V4 Flash & Pro
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48 },
};
