import { HttpClient } from "./http";
import { MistralTextPricing } from "./pricing/mistral";

/**
 * Mistral AI client — OpenAI-compatible API
 * https://docs.mistral.ai/api/
 * Top European AI lab with Mistral Large, Codestral, and free Devstral coding model.
 * Set env var MISTRAL_API_KEY to enable.
 */
export class GenericMistralClient extends HttpClient {
  constructor(apiKey = process.env.MISTRAL_API_KEY) {
    super("https://api.mistral.ai");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(MistralTextPricing);
  }
}
