/**
 * Meta Llama API pricing (USD per 1M tokens)
 * Source: https://llama.developer.meta.com/docs/
 * Free models available directly from Meta.
 */
export const LlamaTextPricing: Record<string, { input: number; output: number }> = {
  // Free models
  "llama-3.3-70b-instruct": { input: 0.0, output: 0.0 },
  "llama-3.3-8b-instruct": { input: 0.0, output: 0.0 },
  "llama-4-scout-17b-16e-instruct": { input: 0.0, output: 0.0 },
  "llama-4-maverick-17b-128e-instruct": { input: 0.0, output: 0.0 },
  // Cerebras-hosted Llama 4 (free)
  "cerebras-llama-4-maverick-17b-128e-instruct": { input: 0.0, output: 0.0 },
  "cerebras-llama-4-scout-17b-16e-instruct": { input: 0.0, output: 0.0 },
  // Groq-hosted Llama 4 (free)
  "groq-llama-4-maverick-17b-128e-instruct": { input: 0.0, output: 0.0 },
  "groq-llama-4-scout-17b-16e-instruct": { input: 0.0, output: 0.0 },
};
