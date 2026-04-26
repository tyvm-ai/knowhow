import { HttpClient } from "./http";
import { DeepSeekTextPricing } from "./pricing/deepseek";

/**
 * DeepSeek client — OpenAI-compatible API
 * https://platform.deepseek.com/api-docs/
 * Industry-leading reasoning (R1) and coding (V3) models at very low cost.
 * Set env var DEEPSEEK_API_KEY to enable.
 */
export class GenericDeepSeekClient extends HttpClient {
  constructor(apiKey = process.env.DEEPSEEK_API_KEY) {
    super("https://api.deepseek.com");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(DeepSeekTextPricing);
  }
}
