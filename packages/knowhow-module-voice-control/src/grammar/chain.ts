/**
 * Command chaining.
 *
 * Splits utterances on "then" / "and then" into chains of commands.
 * Also implements greedy sequence splitting: if the full utterance
 * doesn't match, try splitting into longest sequence of complete commands.
 */

import { normaliseTranscript, tokenise } from "./normalise";

/** Split a normalised utterance on chain connectors ("then", "and then"). */
export function splitOnChainWords(text: string): string[] {
  // Split on " then " or " and then "
  return text
    .split(/\s+(?:and\s+)?then\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Try to find a split of `tokens` into `n` non-empty parts where each part matches a command.
 *  Returns the split indices (exclusive end indices) or undefined.
 */
export function greedySplit(
  tokens: string[],
  tryMatch: (tokens: string[]) => boolean,
): string[][] | undefined {
  // Try splitting at every possible boundary to find a valid sequence.
  const parts = _greedySplit(tokens, tryMatch);
  if (!parts) return undefined;
  return parts;
}

function _greedySplit(
  tokens: string[],
  tryMatch: (tokens: string[]) => boolean,
): string[][] | undefined {
  if (tokens.length === 0) return [];
  // Try consuming as few tokens as possible at the start
  for (let len = 1; len < tokens.length; len++) {
    const head = tokens.slice(0, len);
    const tail = tokens.slice(len);
    if (tryMatch(head)) {
      const tailSplit = _greedySplit(tail, tryMatch);
      if (tailSplit !== undefined) {
        return [head, ...tailSplit];
      }
    }
  }
  // Try consuming all tokens
  if (tryMatch(tokens)) return [tokens];
  return undefined;
}

/**
 * Parse a potentially chained utterance.
 * Returns an array of command segments (each is a token array).
 * Returns a single-element array if no chaining is found.
 */
export function parseChain(
  text: string,
  tryMatch: (tokens: string[]) => boolean,
): string[][] {
  const normalised = normaliseTranscript(text);

  // First try explicit "then" splitting
  const parts = splitOnChainWords(normalised);
  if (parts.length > 1) {
    return parts.map(tokenise);
  }

  // No explicit chain — try as a single command first
  const tokens = tokenise(normalised);
  if (tryMatch(tokens)) {
    return [tokens];
  }

  // No implicit greedy splitting: it turned unmatched speech into chains of
  // unrelated commands ("snap chromeright monitor 2" → two bare-hint clicks).
  // Chains require an explicit "then" / "and then". greedySplit stays exported
  // for callers that opt in.
  return [tokens];
}
