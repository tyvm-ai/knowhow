/**
 * QWEN Cloud pricing (USD per 1M tokens)
 * Source: https://home.qwencloud.com/data/api.json?product=AliyunDeliveryService&action=ListModelSeries
 * International DashScope endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * Last updated: 2026-08-03
 *
 * Notes:
 * - Several Qwen models use tiered pricing based on input context length.
 *   We use the standard tier (≤256k) as the base price here.
 * - DeepSeek and GLM models are also available via QwenCloud's DashScope endpoint.
 * - Video/image/audio generation models have per-second/per-image pricing (not per-token)
 *   and are NOT included in QwenTextPricing.
 */

export const QwenTextPricing: Record<string, { input: number; output: number; cached_input?: number }> = {

  // ---------------------------------------------------------------------------
  // Qwen3.8 series (newest flagship, released 2026-08)
  // ---------------------------------------------------------------------------
  // qwen3.8-max: $2/$6, implicit cache: $0.25, explicit cache creation: $2.5, explicit cache read: $0.17
  "qwen3.8-max": { input: 2.00, output: 6.00, cached_input: 0.25 },

  // ---------------------------------------------------------------------------
  // Qwen3.7 series
  // ---------------------------------------------------------------------------
  // qwen3.7-plus: tiered — ≤256k: $0.4/$1.6, 256k-1M: $1.2/$4.8
  // implicit cache: $0.08 (≤256k), explicit cache creation: $0.5, explicit cache read: $0.04
  "qwen3.7-plus": { input: 0.40, output: 1.60, cached_input: 0.08 },
  "qwen3.7-plus-2026-05-26": { input: 0.40, output: 1.60, cached_input: 0.08 },

  // qwen3.7-flash: tiered — ≤32k: $0.03/$0.13, 32k-256k: $0.10/$0.40, 256k-1M: $0.20/$0.80
  "qwen3.7-flash": { input: 0.03, output: 0.13, cached_input: 0.006 },
  "qwen3.7-flash-2026-07-15": { input: 0.03, output: 0.13, cached_input: 0.006 },

  // qwen3.7-max: $2.50/$7.50, cache: $0.50
  "qwen3.7-max": { input: 2.50, output: 7.50, cached_input: 0.50 },
  "qwen3.7-max-2026-06-08": { input: 2.50, output: 7.50, cached_input: 0.50 },
  "qwen3.7-max-2026-05-20": { input: 2.50, output: 7.50 },

  // ---------------------------------------------------------------------------
  // Qwen3.6 series
  // ---------------------------------------------------------------------------
  // qwen3.6-flash: tiered — ≤256k: $0.25/$1.50, 256k-1M: $1.00/$4.00
  "qwen3.6-flash": { input: 0.25, output: 1.50, cached_input: 0.025 },
  "qwen3.6-flash-2026-04-16": { input: 0.25, output: 1.50 },
  // qwen3.6-plus: tiered — ≤256k: $0.50/$3.00, 256k-1M: $2.00/$6.00
  "qwen3.6-plus": { input: 0.50, output: 3.00, cached_input: 0.05 },
  "qwen3.6-plus-2026-04-02": { input: 0.50, output: 3.00 },

  // ---------------------------------------------------------------------------
  // Legacy alias models (qwen-turbo, qwen-plus, qwen-max, qwen-long)
  // These are rolling aliases that point to the latest generation.
  // ---------------------------------------------------------------------------
  "qwen-turbo": { input: 0.05, output: 0.20, cached_input: 0.005 },
  "qwen-turbo-latest": { input: 0.05, output: 0.20, cached_input: 0.005 },
  "qwen-plus": { input: 0.40, output: 1.20, cached_input: 0.04 },
  "qwen-plus-latest": { input: 0.40, output: 1.20, cached_input: 0.04 },
  "qwen-max": { input: 0.861, output: 3.44, cached_input: 0.086 },
  "qwen-max-latest": { input: 0.861, output: 3.44, cached_input: 0.086 },
  // qwen-long: extended context up to 10M tokens
  "qwen-long": { input: 0.05, output: 0.20, cached_input: 0.005 },

  // ---------------------------------------------------------------------------
  // DeepSeek models (available via QwenCloud/DashScope endpoint)
  // ---------------------------------------------------------------------------
  // DeepSeek-V4-Flash: lightweight MoE, 284B params, 13B activated, 1M context
  "deepseek-v4-flash": { input: 0.20, output: 0.40, cached_input: 0.04 },
  "deepseek-v4-flash-0731": { input: 0.20, output: 0.40, cached_input: 0.04 },
  // DeepSeek-V4-Pro: flagship MoE, 1.6T params, 49B activated, 1M context
  "deepseek-v4-pro": { input: 2.40, output: 4.80, cached_input: 0.20 },
  // DeepSeek-V3.2: sparse attention, 128k context
  // explicit cache creation: $0.713, explicit cache read: $0.057
  "deepseek-v3.2": { input: 0.57, output: 1.71, cached_input: 0.114 },

  // ---------------------------------------------------------------------------
  // GLM models (Zhipu AI, available via QwenCloud/DashScope endpoint)
  // ---------------------------------------------------------------------------
  // GLM-5.2-Fast-Preview: 1M context, high-speed inference
  "glm-5.2-fast-preview": { input: 2.80, output: 8.80, cached_input: 0.56 },
};
