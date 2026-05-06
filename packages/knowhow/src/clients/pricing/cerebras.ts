/**
 * Cerebras pricing (USD per 1M tokens)
 * Source: https://cerebras.ai/pricing
 */
export const CerebrasTextPricing: Record<string, { input: number; output: number }> = {
  "llama3.1-8b": { input: 0.10, output: 0.10 },
  "llama3.3-70b": { input: 0.85, output: 1.20 },
  "qwen-3-235b-a22b-instruct-2507": { input: 0.60, output: 1.20 },
  "gpt-oss-120b": { input: 0.25, output: 0.69 },
  "zai-glm-4.7": { input: 2.25, output: 2.75 },
};
