import { HttpClient } from "./http";
import { MetaTextPricing } from "./pricing/meta";
import { ModelModality } from "./types";

/**
 * Meta Model API client — OpenAI-compatible API
 * https://api.meta.ai
 * Drop-in compatible with the OpenAI SDK (Responses + Chat Completions) and
 * the Anthropic SDK (Messages API). Serves Meta's Muse Spark model with a
 * 1,048,576 token context window.
 * Set env var META_API_KEY to enable.
 */
export class GenericMetaClient extends HttpClient {
  constructor(apiKey = process.env.META_API_KEY) {
    super("https://api.meta.ai");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(MetaTextPricing);
  }

  /**
   * Meta Model API only provides chat completion models — no embeddings, images, audio, or video.
   */
  async getModels(type: ModelModality | "all" = "all") {
    if (type === "embedding") return [];
    return super.getModels(type as string);
  }
}
