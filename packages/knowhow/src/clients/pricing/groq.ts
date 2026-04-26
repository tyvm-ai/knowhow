/**
 * Groq pricing (USD per 1M tokens)
 * Source: https://groq.com/pricing
 */
export const GroqTextPricing: Record<string, { input: number; output: number; cached_input?: number }> = {
  // Llama 4
  "meta-llama/llama-4-scout-17b-16e-instruct": { input: 0.11, output: 0.34 },
  "meta-llama/llama-4-maverick-17b-128e-instruct": { input: 0.20, output: 0.60 },
  // Llama Guard / Prompt Guard
  "llama-guard-3-8b": { input: 0.20, output: 0.20 },
  "meta-llama/llama-guard-4-12b": { input: 0.20, output: 0.20 },
  "meta-llama/llama-prompt-guard-2-22m": { input: 0.03, output: 0.03 },
  "meta-llama/llama-prompt-guard-2-86m": { input: 0.04, output: 0.04 },
  // Llama 3.3
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.3-70b-specdec": { input: 0.59, output: 0.99 },
  // Llama 3.1
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "llama3-70b-8192": { input: 0.59, output: 0.79 },
  "llama3-8b-8192": { input: 0.05, output: 0.08 },
  // DeepSeek
  "deepseek-r1-distill-llama-70b": { input: 0.75, output: 0.99 },
  // Gemma
  "gemma2-9b-it": { input: 0.20, output: 0.20 },
  // Mistral
  "mistral-saba-24b": { input: 0.79, output: 0.79 },
  // Compound
  "compound-beta": { input: 0.0, output: 0.0 },
  // Groq compound (newer aliases)
  "groq/compound": { input: 0.0, output: 0.0 },
  "groq/compound-mini": { input: 0.0, output: 0.0 },
  "compound-beta-mini": { input: 0.0, output: 0.0 },
  // Allam (free)
  "allam-2-7b": { input: 0.0, output: 0.0 },
  // Qwen
  "qwen-qwq-32b": { input: 0.29, output: 0.39 },
  "qwen-2.5-32b": { input: 0.79, output: 0.79 },
  "qwen-2.5-coder-32b": { input: 0.79, output: 0.79 },
  "qwen/qwen3-32b": { input: 0.29, output: 0.59 },
  // MoonshotAI
  "moonshotai/kimi-k2-instruct": { input: 1.0, output: 3.0 },
  "moonshotai/kimi-k2-instruct-0905": { input: 1.0, output: 3.0 },
  // OpenAI OSS models on Groq
  "openai/gpt-oss-120b": { input: 0.15, output: 0.60 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.30 },
  "openai/gpt-oss-safeguard-20b": { input: 0.075, output: 0.30 },
  // Canopy Labs Orpheus (TTS/speech)
  "canopylabs/orpheus-arabic-saudi": { input: 40.0, output: 0.0 },
  "canopylabs/orpheus-v1-english": { input: 0.0, output: 0.0 },
  // Audio / TTS (free)
  "whisper-large-v3": { input: 0.0, output: 0.0 },
  "whisper-large-v3-turbo": { input: 0.0, output: 0.0 },
  "distil-whisper-large-v3-en": { input: 0.0, output: 0.0 },
  "playai-tts": { input: 0.0, output: 0.0 },
  "playai-tts-arabic": { input: 0.0, output: 0.0 },
};
