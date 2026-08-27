import packageJson from "../../package.json";

/**
 * Default Knowhow attribution headers.
 *
 * - `HTTP-Referer`       – OpenRouter analytics / billing attribution.
 * - `X-Title`            – Generic app-name header; supported by OpenRouter
 *                          and other providers that follow the same convention.
 * - `X-OpenRouter-Title` – Legacy OpenRouter-specific alias (kept for
 *                          back-compat; `X-Title` is preferred going forward).
 * - `User-Agent`         – Standard SDK identification.
 */
export const KNOWHOW_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "HTTP-Referer": "https://knowhow.tyvm.ai",
  "X-Title": "Knowhow",
  "X-OpenRouter-Title": "Knowhow",
  "User-Agent": `knowhow/${packageJson.version}`,
});

/**
 * Adds Knowhow's application attribution to an outbound OpenRouter request.
 * Later header sets win case-insensitively, so callers can override defaults
 * without producing duplicate keys.
 */
export function withKnowhowAttribution(
  /**
   * Common overrides:
   *   - `"X-Title"` / `"X-OpenRouter-Title"` – set your own app name
   *   - `"HTTP-Referer"` – set your own referer URL
   *   - any additional custom headers are merged in as-is
   */
  ...headerSets: Array<Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = { ...KNOWHOW_ATTRIBUTION_HEADERS };

  for (const headers of headerSets) {
    if (!headers) continue;
    for (const [key, value] of Object.entries(headers)) {
      const existingKey = Object.keys(result).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase()
      );
      if (existingKey) {
        // Keep the original casing so SDK-owned defaults such as User-Agent
        // are replaced rather than duplicated in their intermediate objects.
        result[existingKey] = value;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}
