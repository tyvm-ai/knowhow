import { HttpClient } from "./http";
import { FireworksTextPricing } from "./pricing/fireworks";
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
   * Supplement the live /v1/models response with any models we have in the
   * pricing table. The Fireworks API sometimes doesn't return newly-released
   * models (e.g. minimax-m3, kimi-k2p7-code) even though they are available
   * for inference — so we use the pricing map as the source of truth for
   * "models we know exist on this provider".
   */
  async getModels(type = "all"): Promise<ModelInfo[]> {
    let liveModels: ModelInfo[] = [];
    try {
      liveModels = await super.getModels(type);
    } catch (_err) {
      // Live API call failed — fall back to pricing map only
    }

    const liveIds = new Set(liveModels.map((m) => m.id));
    const pricingModels: ModelInfo[] = Object.keys(FireworksTextPricing)
      .filter((id) => !liveIds.has(id))
      .map((id) => ({ id, object: "model", owned_by: "fireworks" }));

    return [...liveModels, ...pricingModels];
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
