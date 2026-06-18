/**
 * Fireworks AI pricing (USD per 1M tokens)
 * Source: https://fireworks.ai/pricing
 */
export const FireworksTextPricing: Record<string, { input: number; output: number; cache_hit?: number }> = {
  // Moonshot AI
  "accounts/fireworks/models/kimi-k2p7-code": { input: 0.95, cache_hit: 0.19, output: 4.0 },
  "accounts/fireworks/models/kimi-k2-6": { input: 0.95, cache_hit: 0.16, output: 4.0 },
  "accounts/fireworks/models/kimi-k2-5": { input: 0.60, cache_hit: 0.10, output: 3.0 },

  // MiniMax
  "accounts/fireworks/models/minimax-m3": { input: 0.30, cache_hit: 0.06, output: 1.20 },
  "accounts/fireworks/models/minimax-m2-7": { input: 0.30, cache_hit: 0.06, output: 1.20 },
  "accounts/fireworks/models/minimax-m2-5": { input: 0.30, cache_hit: 0.03, output: 1.20 },

  // Qwen
  "accounts/fireworks/models/qwen3-6-plus": { input: 0.50, cache_hit: 0.10, output: 3.0 },
  "accounts/fireworks/models/qwen3p6-plus": { input: 0.50, cache_hit: 0.10, output: 3.0 },
  "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking": { input: 0.15, cache_hit: 0.08, output: 0.60 },
  "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct": { input: 0.15, cache_hit: 0.08, output: 0.60 },
  "accounts/fireworks/models/qwen3-8b": { input: 0.20, cache_hit: 0.10, output: 0.20 },

  // Z.ai
  "accounts/fireworks/models/glm-5-2": { input: 1.40, cache_hit: 0.26, output: 4.40 },
  "accounts/fireworks/models/glm-5-1": { input: 1.40, cache_hit: 0.26, output: 4.40 },
  "accounts/fireworks/models/glm-5": { input: 1.00, cache_hit: 0.20, output: 3.20 },
  "accounts/fireworks/models/glm-4-7": { input: 0.60, cache_hit: 0.30, output: 2.20 },

  // DeepSeek AI
  "accounts/fireworks/models/deepseek-v3-2": { input: 0.56, cache_hit: 0.28, output: 1.68 },
  "accounts/fireworks/models/deepseek-v3-1": { input: 0.56, cache_hit: 0.28, output: 1.68 },

  // OpenAI OSS
  "accounts/fireworks/models/gpt-oss-120b": { input: 0.15, cache_hit: 0.01, output: 0.60 },
};
