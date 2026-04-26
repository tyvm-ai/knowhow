/**
 * GitHub Copilot pricing — "premium request" multiplier system.
 *
 * GitHub Copilot does NOT charge per token. Instead each model call costs a
 * certain number of "premium requests" from the subscriber's monthly allowance.
 * All models are effectively $0/token from the perspective of knowhow pricing,
 * but we store the multiplier as metadata for informational purposes.
 *
 * Copilot Individual: 300 premium requests/month
 * Copilot Pro:        300 premium requests/month
 * Copilot Business:  300 premium requests/month (per seat)
 * Copilot Enterprise: 300 premium requests/month (per seat)
 *
 * Model IDs are as returned by https://api.githubcopilot.com/models
 * Source: https://docs.github.com/en/copilot/reference/ai-models/supported-models
 */

/** Copilot premium request multipliers (informational only) */
export const CopilotModelMultipliers: Record<string, number> = {
  // OpenAI models
  "gpt-4o": 0,          // free (base request)
  "gpt-4.1": 0,         // free (base request)
  "gpt-5-mini": 0,      // free (base request)
  "gpt-5.2": 1,
  "gpt-5.2-codex": 1,
  "gpt-5.3-codex": 1,
  "gpt-5.4": 1,
  "gpt-5.4-mini": 0.33,
  "gpt-5.4-nano": 0.25,
  "gpt-5.5": 7.5,       // promotional until further notice
  "gpt-5": 1,
  "gpt-5.1": 1,
  "gpt-5.1-codex": 1,
  "gpt-5.1-codex-max": 1,
  "gpt-5.1-codex-mini": 1,
  // Anthropic models
  "claude-haiku-4.5": 0.33,
  "claude-sonnet-4": 1,
  "claude-sonnet-4.5": 1,
  "claude-sonnet-4.6": 1,
  "claude-opus-4.5": 3,
  "claude-opus-4.6": 3,
  "claude-opus-41": 3,
  "claude-opus-4.7": 7.5, // promotional until April 30, 2026
  // Google models
  "gemini-2.5-pro": 1,
  "gemini-3-flash-preview": 0.33,
  "gemini-3.1-pro-preview": 1,
  "gemini-3-pro-preview": 1,
  // xAI models
  "grok-code-fast-1": 0.25,
};

/**
 * Copilot pricing is all $0/token — consumption is via premium request allowance.
 * This map is used by the check-model-pricing script to recognise registered models.
 */
export const CopilotTextPricing: Record<string, { input: number; output: number }> = Object.fromEntries(
  Object.keys(CopilotModelMultipliers).map((id) => [id, { input: 0.0, output: 0.0 }])
);
