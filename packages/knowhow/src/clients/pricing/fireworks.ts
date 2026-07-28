import { ModelPricing } from "./types";

/**
 * Fireworks AI model IDs, pricing, and catalog.
 * Single source of truth for all Fireworks models.
 * Source: https://fireworks.ai/pricing
 */

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const FireworksModels = {
  // Moonshot AI
  KimiK3:      "accounts/fireworks/models/kimi-k3",
  KimiK2p7Code: "accounts/fireworks/models/kimi-k2p7-code",
  KimiK2_6:    "accounts/fireworks/models/kimi-k2-6",
  KimiK2_5:    "accounts/fireworks/models/kimi-k2-5",

  // MiniMax
  MinimaxM3:   "accounts/fireworks/models/minimax-m3",
  MinimaxM2_7: "accounts/fireworks/models/minimax-m2-7",
  MinimaxM2_5: "accounts/fireworks/models/minimax-m2-5",

  // Qwen
  Qwen3p7Plus: "accounts/fireworks/models/qwen3p7-plus",

  // Deprecated Qwen Models
  Qwen3_6Plus:                "accounts/fireworks/models/qwen3-6-plus",
  Qwen3p6Plus:                "accounts/fireworks/models/qwen3p6-plus",
  Qwen3Vl30bA3bThinking:      "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking",
  Qwen3Vl30bA3bInstruct:      "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct",
  Qwen3_8b:                   "accounts/fireworks/models/qwen3-8b",

  // Z.ai
  Glm5p2:  "accounts/fireworks/models/glm-5p2",
  Glm5p1:  "accounts/fireworks/models/glm-5p1",
  Glm5:    "accounts/fireworks/models/glm-5",
  Glm4_7:  "accounts/fireworks/models/glm-4-7",

  // DeepSeek AI
  DeepseekV4Pro:   "accounts/fireworks/models/deepseek-v4-pro",
  DeepseekV4Flash: "accounts/fireworks/models/deepseek-v4-flash",
  DeepseekV3_2:    "accounts/fireworks/models/deepseek-v3-2",
  DeepseekV3_1:    "accounts/fireworks/models/deepseek-v3-1",

  // OpenAI OSS
  GptOss120b: "accounts/fireworks/models/gpt-oss-120b",

  // Embedding / Reranker
  Qwen3Embedding8b: "accounts/fireworks/models/qwen3-embedding-8b",
  Qwen3Reranker8b:  "accounts/fireworks/models/qwen3-reranker-8b",
} as const;

// ─── Text model pricing (USD per 1M tokens) ───────────────────────────────────

export const FireworksTextPricing: Record<string, ModelPricing> = {
  // Moonshot AI
  [FireworksModels.KimiK3]:       { input: 3.0, cache_hit: 0.30, output: 15.0 },
  [FireworksModels.KimiK2p7Code]: { input: 0.95, cache_hit: 0.19, output: 4.0 },
  [FireworksModels.KimiK2_6]:     { input: 0.95, cache_hit: 0.16, output: 4.0 },
  [FireworksModels.KimiK2_5]:     { input: 0.60, cache_hit: 0.10, output: 3.0 },

  // MiniMax
  [FireworksModels.MinimaxM3]:    { input: 0.30, cache_hit: 0.06, output: 1.20 },
  [FireworksModels.MinimaxM2_7]:  { input: 0.30, cache_hit: 0.06, output: 1.20 },
  [FireworksModels.MinimaxM2_5]:  { input: 0.30, cache_hit: 0.03, output: 1.20 },

  // Qwen
  [FireworksModels.Qwen3p7Plus]:  { input: 0.40, cache_hit: 0.08, output: 1.60 },

  // Deprecated QWEN Models
  [FireworksModels.Qwen3_6Plus]:           { input: 0.50, cache_hit: 0.10, output: 3.0, deprecated: true },
  [FireworksModels.Qwen3p6Plus]:           { input: 0.50, cache_hit: 0.10, output: 3.0, deprecated: true },
  [FireworksModels.Qwen3Vl30bA3bThinking]: { input: 0.15, cache_hit: 0.08, output: 0.60, deprecated: true },
  [FireworksModels.Qwen3Vl30bA3bInstruct]: { input: 0.15, cache_hit: 0.08, output: 0.60, deprecated: true },
  [FireworksModels.Qwen3_8b]:              { input: 0.20, cache_hit: 0.10, output: 0.20, deprecated: true },

  // Z.ai
  [FireworksModels.Glm5p2]: { input: 1.40, cache_hit: 0.26, output: 4.40 },
  [FireworksModels.Glm5p1]: { input: 1.40, cache_hit: 0.26, output: 4.40 },
  [FireworksModels.Glm5]:   { input: 1.00, cache_hit: 0.20, output: 3.20, deprecated: true },
  [FireworksModels.Glm4_7]: { input: 0.60, cache_hit: 0.30, output: 2.20, deprecated: true },

  // DeepSeek AI
  [FireworksModels.DeepseekV4Pro]:   { input: 1.74, cache_hit: 0.15, output: 3.48 },
  [FireworksModels.DeepseekV4Flash]: { input: 0.14, cache_hit: 0.03, output: 0.28 },
  [FireworksModels.DeepseekV3_2]:    { input: 0.56, cache_hit: 0.28, output: 1.68, deprecated: true },
  [FireworksModels.DeepseekV3_1]:    { input: 0.56, cache_hit: 0.28, output: 1.68, deprecated: true },

  // OpenAI OSS
  [FireworksModels.GptOss120b]: { input: 0.15, cache_hit: 0.01, output: 0.60 },
};

/**
 * Fireworks AI embedding/reranker model pricing (USD per 1M tokens)
 * Source: https://fireworks.ai/pricing
 */
export const FireworksEmbeddingPricing: Record<string, ModelPricing> = {
  // Qwen3 Embedding 8B — $0.10/M tokens, context 40k
  [FireworksModels.Qwen3Embedding8b]: { input: 0.10, output: 0.10 },

  // Qwen3 Reranker 8B — $0.20/M tokens, context 40k
  [FireworksModels.Qwen3Reranker8b]: { input: 0.20, output: 0.20 },
};
