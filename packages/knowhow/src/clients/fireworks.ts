import { HttpClient } from "./http";
import { FireworksTextPricing, FireworksEmbeddingPricing } from "./pricing/fireworks";
import { CompletionOptions, CompletionResponse } from "./types";

type ModelInfo = { id: string; object: string; owned_by: string };

/**
 * Fireworks AI client — OpenAI-compatible API (fast serverless inference)
 * https://docs.fireworks.ai/api-reference/introduction
 * Set env var FIREWORKS_API_KEY to enable.
 */
export class GenericFireworksClient extends HttpClient {
  constructor(apiKey = process.env.FIREWORKS_API_KEY) {
    super("https://api.fireworks.ai/inference");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(FireworksTextPricing);
  }

  /**
   * Skip the live /v1/models API call entirely — Fireworks' model listing
   * endpoint frequently returns 500s and triggers slow exponential backoff.
   * Our pricing map is the authoritative source of truth for available models.
   */
  async getModels(_type = "all"): Promise<ModelInfo[]> {
    // Return embedding/reranker models when requested
    if (_type === "embedding") {
      return Object.keys(FireworksEmbeddingPricing).map((id) => ({
        id,
        object: "model",
        owned_by: "fireworks",
      }));
    }

    return Object.keys(FireworksTextPricing).map((id) => ({
      id,
      object: "model",
      owned_by: "fireworks",
    }));
  }

  /**
   * Sanitize the request before sending to Fireworks.
   * Some models (e.g. kimi-k2p7-code) reject extra fields like:
   *   - tools[N].function.returns  (non-standard extension)
   *   - long_ttl_cache             (Anthropic-specific cache flag)
   */
  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const sanitized: CompletionOptions = {
      ...options,
      // Strip Anthropic-specific field not accepted by Fireworks
      long_ttl_cache: undefined,
    };

    if (sanitized.tools) {
      sanitized.tools = sanitized.tools.map((tool) => {
        const { returns, ...fnRest } = tool.function as any;
        return {
          ...tool,
          function: fnRest,
        };
      });
    }

    return super.createChatCompletion(sanitized);
  }
}
