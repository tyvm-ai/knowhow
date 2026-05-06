/**
 * Mistral AI pricing (USD per 1M tokens)
 * Source: https://mistral.ai/technology/#pricing
 */
export const MistralTextPricing: Record<string, { input: number; output: number; cached_input?: number }> = {
  // Mistral Large (latest = 2512 as of 2026-04, price reduced from $2/$6)
  // Source: openrouter.ai/api/v1/models (mistral-large-2512 = $0.5/$1.5)
  "mistral-large-latest": { input: 0.5, output: 1.5 },
  "mistral-large-2512": { input: 0.5, output: 1.5 },
  "mistral-large-2411": { input: 2.0, output: 6.0 },
  // Mistral Small (latest = 2603 as of 2026-04, price updated)
  // Source: openrouter.ai/api/v1/models (mistral-small-2603 = $0.15/$0.60)
  "mistral-small-latest": { input: 0.15, output: 0.6 },
  "mistral-small-2603": { input: 0.15, output: 0.6 },
  "mistral-small-2501": { input: 0.1, output: 0.3 },
  // Mistral Medium
  "mistral-medium-latest": { input: 0.4, output: 2.0 },
  // Codestral (code model)
  "codestral-latest": { input: 0.3, output: 0.9 },
  "codestral-2501": { input: 0.3, output: 0.9 },
  // Devstral (free coding assistant)
  "devstral-small-latest": { input: 0.0, output: 0.0 },
  "labs-devstral-small-2512": { input: 0.0, output: 0.0 },
  // Pixtral (multimodal)
  "pixtral-large-latest": { input: 2.0, output: 6.0 },
  "pixtral-12b-2409": { input: 0.15, output: 0.15 },
  // Ministral
  "ministral-3b-latest": { input: 0.04, output: 0.04 },
  "ministral-8b-latest": { input: 0.1, output: 0.1 },
  // Mistral NeMo
  "open-mistral-nemo": { input: 0.15, output: 0.15 },
  // Embeddings
  "mistral-embed": { input: 0.1, output: 0.0 },
};
