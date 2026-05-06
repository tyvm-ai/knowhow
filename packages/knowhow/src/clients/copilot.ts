import { HttpClient } from "./http";
import { CopilotTextPricing } from "./pricing/copilot";

/**
 * GitHub Copilot client — OpenAI-compatible API
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models
 *
 * GitHub Copilot exposes an OpenAI-compatible endpoint at https://api.githubcopilot.com
 * that allows subscribers to use premium models (Claude Opus, GPT-5.x, Gemini, Grok etc.)
 * via their Copilot subscription's premium request allowance — no per-token charges.
 *
 * Authentication: uses a GitHub token (same as GITHUB_TOKEN / a personal access token
 * or OAuth token with copilot scope).
 *
 * Set env var GITHUB_COPILOT_TOKEN (preferred) or GITHUB_TOKEN to enable.
 */
export class GitHubCopilotClient extends HttpClient {
  constructor(apiKey = process.env.GITHUB_COPILOT_TOKEN ?? process.env.GITHUB_TOKEN) {
    super("https://api.githubcopilot.com");
    if (apiKey) this.setJwt(apiKey);
    this.setPrices(CopilotTextPricing);
  }
}
