/**
 * OpenRouter pricing (USD per 1M tokens)
 * Source: https://openrouter.ai/models
 * Models with `:free` suffix are free. Others are paid.
 * OpenRouter acts as an aggregator — prices may vary from original providers.
 */
export const OpenRouterTextPricing: Record<string, { input: number; output: number }> = {
  // Free models (`:free` suffix)
  "deepseek/deepseek-r1:free": { input: 0.0, output: 0.0 },
  "deepseek/deepseek-chat-v3-0324:free": { input: 0.0, output: 0.0 },
  "meta-llama/llama-3.3-70b-instruct:free": { input: 0.0, output: 0.0 },
  "meta-llama/llama-4-maverick:free": { input: 0.0, output: 0.0 },
  "meta-llama/llama-4-scout:free": { input: 0.0, output: 0.0 },
  "google/gemma-3-27b-it:free": { input: 0.0, output: 0.0 },
  "google/gemma-3-12b-it:free": { input: 0.0, output: 0.0 },
  "microsoft/phi-4:free": { input: 0.0, output: 0.0 },
  "qwen/qwen3-235b-a22b:free": { input: 0.0, output: 0.0 },
  "qwen/qwen3-30b-a3b:free": { input: 0.0, output: 0.0 },
  "mistralai/mistral-7b-instruct:free": { input: 0.0, output: 0.0 },
  "nousresearch/hermes-3-llama-3.1-405b:free": { input: 0.0, output: 0.0 },
  // Paid models (popular)
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
  "anthropic/claude-3-haiku": { input: 0.25, output: 1.25 },
  // Source: openrouter.ai/api/v1/models (2026-04)
  "deepseek/deepseek-r1": { input: 0.7, output: 2.5 },
  "deepseek/deepseek-chat-v3-0324": { input: 0.2, output: 0.77 },
  "meta-llama/llama-3.3-70b-instruct": { input: 0.12, output: 0.3 },
  "google/gemini-2.0-flash-001": { input: 0.1, output: 0.4 },
  // Source: openrouter.ai/api/v1/models (2026-04) — qwen3-235b-a22b = $0.455/$1.82
  // Note: models.dev shows $0.15/$0.85 for dated variant, using OpenRouter live price
  "qwen/qwen3-235b-a22b": { input: 0.455, output: 1.82 },
  "qwen/qwen3-235b-a22b-07-25": { input: 0.15, output: 0.85 },
  "mistralai/mistral-large-2411": { input: 2.0, output: 6.0 },
};
