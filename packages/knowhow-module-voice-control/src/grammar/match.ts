/**
 * Grammar pattern matcher.
 *
 * Matches a normalised utterance (tokens) against a compiled pattern,
 * returning slot values and a score.
 */

import { PatternToken } from "./compile";
import { getSlotMatcher } from "./slots";

export interface MatchResult {
  /** Slots filled by this match. */
  slots: Record<string, unknown>;
  /** Score: higher is better. Exact tokens = +2, fuzzy = +1, slot = +1. */
  score: number;
  /** Number of tokens consumed. */
  consumed: number;
}

/** Levenshtein edit distance (character-level). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Match a single literal token against a spoken token.
 * Per grammar.md F4: edit tolerance only for tokens ≥ 5 chars; shorter = exact only.
 */
function matchLiteral(spoken: string, literal: string): { score: number } | undefined {
  if (spoken === literal) return { score: 2 };
  // Exact match after removing hyphens/apostrophes
  const sc = spoken.replace(/[-']/g, "");
  const lc = literal.replace(/[-']/g, "");
  if (sc === lc) return { score: 2 };
  // Edit distance tolerance only for tokens ≥ 5 chars
  if (literal.length >= 5 && spoken.length >= 3) {
    const dist = editDistance(spoken, literal);
    if (dist <= 1) return { score: 1 };
  }
  // For phrases (multi-word literals) — should not happen since we tokenize, but guard anyway
  return undefined;
}

interface MatchState {
  slots: Record<string, unknown>;
  score: number;
  tokenIdx: number; // current position in tokens array
}

/**
 * Match a sequence of pattern tokens starting at `state.tokenIdx`.
 * Returns all successful terminal states.
 */
function matchSequence(
  pattern: PatternToken[],
  patternIdx: number,
  tokens: string[],
  state: MatchState,
  ctx: Record<string, unknown>,
): MatchState[] {
  if (patternIdx >= pattern.length) {
    // Pattern fully consumed — success if we consumed all tokens
    // (allow trailing tokens to not match for partial matching, but we'll score less)
    return [state];
  }
  const pt = pattern[patternIdx];

  if (pt.kind === "literal") {
    const tok = tokens[state.tokenIdx];
    if (tok === undefined) return [];
    const lit = matchLiteral(tok, pt.word);
    if (!lit) return [];
    return matchSequence(pattern, patternIdx + 1, tokens, {
      ...state,
      slots: state.slots,
      score: state.score + lit.score,
      tokenIdx: state.tokenIdx + 1,
    }, ctx);
  }

  if (pt.kind === "optional") {
    // Try without consuming anything
    const withoutResults = matchSequence(pattern, patternIdx + 1, tokens, state, ctx);
    // Try each alternative
    const withResults: MatchState[] = [];
    for (const alt of pt.tokens) {
      const altResults = matchSequence(
        [...alt, ...pattern.slice(patternIdx + 1)],
        0,
        tokens,
        state,
        ctx,
      );
      withResults.push(...altResults);
    }
    return [...withoutResults, ...withResults];
  }

  if (pt.kind === "alt") {
    const results: MatchState[] = [];
    for (const alt of pt.alternatives) {
      const altResults = matchSequence(
        [...alt, ...pattern.slice(patternIdx + 1)],
        0,
        tokens,
        state,
        ctx,
      );
      results.push(...altResults);
    }
    return results;
  }

  if (pt.kind === "enum-slot") {
    const tok = tokens[state.tokenIdx];
    if (tok === undefined) return [];
    // Check each enum value (which may be multi-token)
    for (const val of pt.values) {
      const valTokens = val.split(" ").filter(Boolean);
      if (valTokens.length === 0) continue;
      let match = true;
      for (let i = 0; i < valTokens.length; i++) {
        const spoken = tokens[state.tokenIdx + i];
        if (!spoken || !matchLiteral(spoken, valTokens[i])) { match = false; break; }
      }
      if (match) {
        const newSlots = { ...state.slots, [pt.name]: val };
        return matchSequence(pattern, patternIdx + 1, tokens, {
          ...state,
          slots: newSlots,
          score: state.score + 2,
          tokenIdx: state.tokenIdx + valTokens.length,
        }, ctx);
      }
    }
    return [];
  }

  if (pt.kind === "slot") {
    const matcher = getSlotMatcher(pt.type);
    if (!matcher) return [];
    const result = matcher.match(tokens, state.tokenIdx, ctx);
    if (!result) return [];
    const newSlots = { ...state.slots, [pt.name]: result.value };
    return matchSequence(pattern, patternIdx + 1, tokens, {
      ...state,
      slots: newSlots,
      score: state.score + 1,
      tokenIdx: state.tokenIdx + result.consumed,
    }, ctx);
  }

  return [];
}

/**
 * Match `tokens` against `pattern`.
 * Returns the best match (highest score, all tokens consumed), or undefined.
 */
export function matchPattern(
  pattern: PatternToken[],
  tokens: string[],
  ctx: Record<string, unknown> = {},
): MatchResult | undefined {
  const initial: MatchState = { slots: {}, score: 0, tokenIdx: 0 };
  const results = matchSequence(pattern, 0, tokens, initial, ctx);
  // Only accept results that consumed all tokens
  const complete = results.filter((r) => r.tokenIdx >= tokens.length);
  if (!complete.length) return undefined;
  // Pick highest score
  complete.sort((a, b) => b.score - a.score);
  const best = complete[0];
  return { slots: best.slots, score: best.score, consumed: best.tokenIdx };
}
