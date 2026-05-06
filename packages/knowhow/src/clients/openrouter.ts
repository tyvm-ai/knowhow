import { HttpClient } from "./http";
import { OpenRouterTextPricing } from "./pricing/openrouter";

/**
 * OpenRouter client — OpenAI-compatible API aggregator
 * https://openrouter.ai/docs
 * 39+ free models; append `:free` suffix to a model id for the free variant.
 * One API key gives access to models from many providers.
 * Set env var OPENROUTER_API_KEY to enable.
 */
export class GenericOpenRouterClient extends HttpClient {
  constructor(apiKey = process.env.OPENROUTER_API_KEY) {
    super("https://openrouter.ai/api");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(OpenRouterTextPricing);
  }
}
