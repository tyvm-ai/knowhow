import { HttpClient } from "./http";
import { GroqTextPricing } from "./pricing/groq";

/**
 * Groq client — OpenAI-compatible API (ultra-fast inference)
 * https://console.groq.com/docs/openai
 * Set env var GROQ_API_KEY to enable.
 */
export class GenericGroqClient extends HttpClient {
  constructor(apiKey = process.env.GROQ_API_KEY) {
    super("https://api.groq.com/openai");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(GroqTextPricing);
  }
}
