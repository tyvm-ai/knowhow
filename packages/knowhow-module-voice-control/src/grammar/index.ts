/**
 * Grammar engine public API.
 *
 * Integrates compile, match, normalise, dictation, chain.
 */

export { registerSlotType, getSlotMatcher, APP_ALIASES } from "./slots";
export { compilePattern } from "./compile";
export { matchPattern } from "./match";
export { normaliseTranscript, tokenise } from "./normalise";
export { convertDictation, applyCase, expandSpell, expandNato } from "./dictation";
export { splitOnChainWords, parseChain, greedySplit } from "./chain";

import type { VoiceCommandExtension } from "../voiceCommands";
import { compilePattern, PatternToken } from "./compile";
import { matchPattern } from "./match";
import { normaliseTranscript, tokenise } from "./normalise";
import { parseChain } from "./chain";
import { matchPhrase } from "../commandMode";

// Re-export PatternToken for external use
export type { PatternToken } from "./compile";
export type { MatchResult } from "./match";

export interface ParsedCommand {
  command: VoiceCommandExtension;
  slots: Record<string, unknown>;
  repeat: number;
  score: number;
}

export type ParseResult =
  | { kind: "match"; result: ParsedCommand }
  | { kind: "chain"; results: ParsedCommand[] }
  | { kind: "none" };

/** Compiled pattern cache. */
const patternCache = new Map<string, PatternToken[]>();

function getPattern(pattern: string): PatternToken[] {
  let compiled = patternCache.get(pattern);
  if (!compiled) {
    compiled = compilePattern(pattern);
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Extract trailing repeat count from tokens.
 * e.g. ["down", "5"] → { tokens: ["down"], repeat: 5 }
 * e.g. ["undo", "three", "times"] → { tokens: ["undo"], repeat: 3 }
 */
function extractRepeat(tokens: string[]): { tokens: string[]; repeat: number } {
  if (tokens.length < 2) return { tokens, repeat: 1 };

  const WORD_NUMS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };

  // Check for trailing "N times" or "N"
  const last = tokens[tokens.length - 1];
  const secondLast = tokens[tokens.length - 2];

  if (last === "times" && secondLast) {
    const n = parseInt(secondLast, 10) || WORD_NUMS[secondLast];
    if (n) return { tokens: tokens.slice(0, -2), repeat: n };
  }

  const n = parseInt(last, 10) || WORD_NUMS[last];
  if (n && tokens.length > 1) {
    return { tokens: tokens.slice(0, -1), repeat: n };
  }

  return { tokens, repeat: 1 };
}

/**
 * Try to match tokens against a single command.
 * Respects `pattern`, `patterns`, and falls back to plain `phrase`/`aliases` matching.
 */
function matchCommand(
  tokens: string[],
  command: VoiceCommandExtension,
  ctx: Record<string, unknown> = {},
): { slots: Record<string, unknown>; score: number } | undefined {
  const patterns: string[] = [];
  if (typeof (command as any).pattern === "string") patterns.push((command as any).pattern);
  if (Array.isArray((command as any).patterns)) patterns.push(...(command as any).patterns);

  // Try compiled patterns
  for (const pat of patterns) {
    const compiled = getPattern(pat);
    const result = matchPattern(compiled, tokens, ctx);
    if (result) return result;
  }

  // Fall back to plain phrase/aliases matching
  const speakable = tokenise(tokens.join(" ")).join(" ");
  const phraseMatch = matchPhrase(speakable, [command]);
  // An exact (all-literal) phrase match must outrank patterns that only match
  // by filling a slot, e.g. "toggle mouse" (literal) vs "toggle {hint}".
  // Literal tokens score 2 each in patterns, so 2/token + 1 beats any slot fill.
  if (phraseMatch.matched) return { slots: {}, score: tokens.length * 2 + 1 };

  return undefined;
}

/**
 * Parse a single utterance against a set of commands.
 *
 * Context-first matching: commands with matching `context.app` are tried before global ones.
 * Supports chaining ("select all then copy") and repeat ("down 5").
 *
 * Repeat-vs-slot resolution:
 *   We try matching the FULL token sequence first. If that succeeds on a command
 *   with `repeatable: false`, we use repeat=1 (the trailing number is part of a
 *   slot, not a repeat count). If the full-token match is on a repeatable command
 *   (or there is no full match), we also try with extractRepeat and pick whichever
 *   gives a higher score. This means "select input 2" routes to hints.select-hint
 *   with hint={roleName:"input",index:2}, while "down 5" still gives repeat=5.
 */
export function parseUtterance(
  text: string,
  commands: VoiceCommandExtension[],
  ctx: Record<string, unknown> = {},
): ParseResult {
  const normalised = normaliseTranscript(text);
  const fullTokens = tokenise(normalised);

  // Build a try-match function for chaining (tries full tokens, then with extractRepeat)
  const tryMatch = (tokens: string[]): boolean => {
    if (commands.some((c) => matchCommand(tokens, c, ctx) !== undefined)) return true;
    const { tokens: coreTokens } = extractRepeat(tokens);
    if (coreTokens.length < tokens.length) {
      return commands.some((c) => matchCommand(coreTokens, c, ctx) !== undefined);
    }
    return false;
  };

  // Check for chained commands
  const chain = parseChain(normalised, tryMatch);
  if (chain.length > 1) {
    const results: ParsedCommand[] = [];
    for (const segTokens of chain) {
      const step = resolveTokensAndRepeat(segTokens, commands, ctx);
      if (!step) return { kind: "none" }; // partial chain fails entirely
      results.push(step);
    }
    return { kind: "chain", results };
  }

  // Single command
  const step = resolveTokensAndRepeat(fullTokens, commands, ctx);
  if (!step) return { kind: "none" };
  return { kind: "match", result: step };
}

/**
 * Resolve the best match for a token sequence, choosing between full-token
 * match (slots consume trailing numbers) and extractRepeat match (repeat count).
 *
 * Priority:
 * 1. Full-token match on a `repeatable: false` command → always wins (repeat=1)
 * 2. If no full match, try extractRepeat
 * 3. If both match, prefer higher score; tie-break prefers full match
 */
function resolveTokensAndRepeat(
  tokens: string[],
  commands: VoiceCommandExtension[],
  ctx: Record<string, unknown>,
): ParsedCommand | undefined {
  // Try full token sequence
  const fullMatch = findBestMatch(tokens, commands, ctx);

  // If the full match is on a non-repeatable command, use it with repeat=1
  if (fullMatch && (fullMatch.command as any).repeatable === false) {
    return { ...fullMatch, repeat: 1 };
  }

  // Try with extractRepeat
  const extracted = extractRepeat(tokens);
  const repeatMatch = extracted.repeat > 1
    ? findBestMatch(extracted.tokens, commands, ctx)
    : undefined;

  if (fullMatch && repeatMatch) {
    // Both matched. When the command is explicitly repeatable and extractRepeat
    // found a repeat > 1, prefer the repeat result (so "down 5" → repeat=5,
    // not {n:5} consumed inline with repeat=1).
    const isRepeatable = (repeatMatch.command as any).repeatable === true;
    if (isRepeatable && extracted.repeat > 1) {
      return { ...repeatMatch, repeat: extracted.repeat };
    }
    // Otherwise prefer higher score; tie-break: prefer full match
    if (fullMatch.score >= repeatMatch.score) {
      return { ...fullMatch, repeat: 1 };
    }
    return { ...repeatMatch, repeat: extracted.repeat };
  }

  if (repeatMatch) {
    return { ...repeatMatch, repeat: extracted.repeat };
  }

  if (fullMatch) {
    return { ...fullMatch, repeat: 1 };
  }

  return undefined;
}

function findBestMatch(
  tokens: string[],
  commands: VoiceCommandExtension[],
  ctx: Record<string, unknown>,
): { command: VoiceCommandExtension; slots: Record<string, unknown>; score: number } | undefined {
  const focusedApp = ctx.frontmostApp as string | undefined;

  // Partition: context-matching commands first, then global
  const contextMatching = focusedApp
    ? commands.filter((c) => {
        const ctxFilter = (c as any).context?.app;
        if (!ctxFilter) return false;
        if (Array.isArray(ctxFilter)) return ctxFilter.some((a: string) => a.toLowerCase() === focusedApp.toLowerCase());
        return ctxFilter.toLowerCase() === focusedApp.toLowerCase();
      })
    : [];
  const globals = commands.filter((c) => !(c as any).context?.app);

  let best: { command: VoiceCommandExtension; slots: Record<string, unknown>; score: number } | undefined;

  for (const group of [contextMatching, globals]) {
    for (const command of group) {
      const m = matchCommand(tokens, command, ctx);
      if (m && (!best || m.score > best.score)) {
        best = { command, slots: m.slots, score: m.score };
      }
    }
    // If we found a match in context-matching group, prefer it
    if (best && group === contextMatching) return best;
  }

  return best;
}
