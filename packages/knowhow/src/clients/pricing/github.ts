/**
 * GitHub Models pricing (USD per 1M tokens)
 * Source: https://github.com/marketplace/models
 * All models are free within rate limits for GitHub users.
 * Low-tier (higher rate limits) and high-tier (lower rate limits) exist.
 */
export const GitHubModelsTextPricing: Record<string, { input: number; output: number }> = {
  // OpenAI via GitHub (free)
  "openai/gpt-4o": { input: 0.0, output: 0.0 },
  "openai/gpt-4o-mini": { input: 0.0, output: 0.0 },
  "openai/o1": { input: 0.0, output: 0.0 },
  "openai/o1-mini": { input: 0.0, output: 0.0 },
  "openai/o3-mini": { input: 0.0, output: 0.0 },
  "openai/o4-mini": { input: 0.0, output: 0.0 },
  "openai/gpt-4.1": { input: 0.0, output: 0.0 },
  "openai/gpt-4.1-mini": { input: 0.0, output: 0.0 },
  "openai/gpt-4.1-nano": { input: 0.0, output: 0.0 },
  "openai/o3": { input: 0.0, output: 0.0 },
  // DeepSeek via GitHub (free)
  "deepseek/deepseek-r1": { input: 0.0, output: 0.0 },
  "deepseek/deepseek-v3-0324": { input: 0.0, output: 0.0 },
  // Microsoft Phi via GitHub (free)
  "microsoft/phi-4": { input: 0.0, output: 0.0 },
  "microsoft/phi-4-mini-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-4-multimodal-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-4-mini-reasoning": { input: 0.0, output: 0.0 },
  "microsoft/phi-4-reasoning": { input: 0.0, output: 0.0 },
  "microsoft/phi-3-medium-128k-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3-medium-4k-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3-mini-128k-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3-mini-4k-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3-small-128k-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3-small-8k-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3.5-mini-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3.5-moe-instruct": { input: 0.0, output: 0.0 },
  "microsoft/phi-3.5-vision-instruct": { input: 0.0, output: 0.0 },
  "microsoft/mai-ds-r1": { input: 0.0, output: 0.0 },
  // Meta Llama via GitHub (free)
  "meta/llama-3.3-70b-instruct": { input: 0.0, output: 0.0 },
  "meta/llama-3.2-11b-vision-instruct": { input: 0.0, output: 0.0 },
  "meta/llama-3.1-405b-instruct": { input: 0.0, output: 0.0 },
  "meta/llama-3.2-90b-vision-instruct": { input: 0.0, output: 0.0 },
  "meta/llama-4-maverick-17b-128e-instruct-fp8": { input: 0.0, output: 0.0 },
  "meta/llama-4-scout-17b-16e-instruct": { input: 0.0, output: 0.0 },
  "meta/meta-llama-3-70b-instruct": { input: 0.0, output: 0.0 },
  "meta/meta-llama-3-8b-instruct": { input: 0.0, output: 0.0 },
  "meta/meta-llama-3.1-405b-instruct": { input: 0.0, output: 0.0 },
  "meta/meta-llama-3.1-70b-instruct": { input: 0.0, output: 0.0 },
  "meta/meta-llama-3.1-8b-instruct": { input: 0.0, output: 0.0 },
  // Mistral via GitHub (free)
  "mistral-ai/mistral-large-2411": { input: 0.0, output: 0.0 },
  "mistral-ai/mistral-small-2503": { input: 0.0, output: 0.0 },
  "mistral-ai/codestral-2501": { input: 0.0, output: 0.0 },
  "mistral-ai/ministral-3b": { input: 0.0, output: 0.0 },
  "mistral-ai/mistral-medium-2505": { input: 0.0, output: 0.0 },
  "mistral-ai/mistral-nemo": { input: 0.0, output: 0.0 },
  // Cohere via GitHub (free)
  "cohere/cohere-command-r-plus-08-2024": { input: 0.0, output: 0.0 },
  "cohere/cohere-command-r-08-2024": { input: 0.0, output: 0.0 },
  "cohere/cohere-command-a": { input: 0.0, output: 0.0 },
  // AI21 via GitHub (free)
  "ai21-labs/ai21-jamba-1.5-mini": { input: 0.0, output: 0.0 },
  "ai21-labs/ai21-jamba-1.5-large": { input: 0.0, output: 0.0 },
  // Core42
  "core42/jais-30b-chat": { input: 0.0, output: 0.0 },
  // xAI via GitHub (free)
  "xai/grok-3": { input: 0.0, output: 0.0 },
  "xai/grok-3-mini": { input: 0.0, output: 0.0 },
};
