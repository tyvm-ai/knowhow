import { HttpClient } from "./http";
import { FireworksTextPricing } from "./pricing/fireworks";

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
}
