import { HttpClient } from "./http";
import { GitHubModelsTextPricing } from "./pricing/github";

/**
 * GitHub Models client — OpenAI-compatible API
 * https://docs.github.com/en/github-models
 * Free access to premium models (GPT-4o, DeepSeek R1, Llama, Phi etc.) with a GitHub token.
 * Set env var GITHUB_TOKEN to enable.
 */
export class GenericGitHubModelsClient extends HttpClient {
  constructor(apiKey = process.env.GITHUB_TOKEN) {
    super("https://models.github.ai/inference");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(GitHubModelsTextPricing);
  }
}
