import { HttpClient } from "./http";
import { QwenTextPricing } from "./pricing/qwen";

/**
 * QWEN Cloud client — OpenAI-compatible API
 * https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 * Alibaba Cloud's Qwen model family via the international DashScope endpoint.
 * Set env var QWEN_CLOUD_API_KEY to enable.
 */
export class GenericQwenClient extends HttpClient {
  constructor(apiKey = process.env.QWEN_CLOUD_API_KEY) {
    super("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(QwenTextPricing);
  }
}
