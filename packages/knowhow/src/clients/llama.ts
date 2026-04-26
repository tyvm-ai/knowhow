import { HttpClient } from "./http";
import { LlamaTextPricing } from "./pricing/llama";

/**
 * Meta Llama API client — OpenAI-compatible API
 * https://llama.developer.meta.com/docs/
 * Direct from Meta: free Llama 3.x, Llama 4, and Cerebras/Groq-hosted variants.
 * Set env var LLAMA_API_KEY to enable.
 */
export class GenericLlamaClient extends HttpClient {
  constructor(apiKey = process.env.LLAMA_API_KEY) {
    super("https://api.llama.com/compat");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(LlamaTextPricing);
  }
}
