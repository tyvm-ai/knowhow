import { HttpClient } from "./http";
import { NvidiaTextPricing } from "./pricing/nvidia";

/**
 * NVIDIA NIM client — OpenAI-compatible API
 * https://build.nvidia.com/explore/discover
 * 76+ free models including Llama, Mistral, Phi, Flux image generation.
 * Set env var NVIDIA_API_KEY to enable.
 */
export class GenericNvidiaClient extends HttpClient {
  constructor(apiKey = process.env.NVIDIA_API_KEY) {
    super("https://integrate.api.nvidia.com");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(NvidiaTextPricing);
  }
}
