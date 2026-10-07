/**
 * tmux intent recovery: everything about whisper mishearing the made-up word
 * "tmux" lives here (the generic engine knows nothing about it).
 *
 * Whisper turns "tmux" into real words almost every time: "too much love",
 * "15 months left", "team marks left", "teammates down". This module has:
 *   - NORMALISE_RULES: the static mishear table (registered with the grammar by the pack)
 *   - inferTmuxIntent / isBareTmux: fuzzy scoring of unmatched utterances
 *   - TMUX_RECOVERER: the IntentRecoverer the RecoveryEngine runs
 *       fuzzy "tmux <dir>"    → rewrite (trusted when a terminal is frontmost, learned prefixes anywhere,
 *                               otherwise asks "did you mean tmux left?")
 *       bare "tmux"/"tmarks"  → latch: a lone "left"/"down"/… within 5s completes it
 */

import type { NormaliseRule } from "../grammar/normalise";
import type { LearnedStore } from "../recovery/learned";
import type { IntentRecoverer, RecoveryResult } from "../recovery/types";

export const TMUX_RECOVERER_NAME = "tmux";
/** How long a bare "tmux" waits for a follow-up "left"/"down"/…. */
export const TMUX_LATCH_MS = 5000;

/** Terminal apps: where a tmux guess is trusted enough to run without asking. */
export const TERMINAL_APPS = /^(?:ghostty|iterm2?|terminal|wezterm(?:-gui)?|kitty|alacritty|warp|hyper|tabby|rio|wave)$/i;

export function isTerminalApp(app: string | undefined): boolean {
  return !!app && TERMINAL_APPS.test(app.trim());
}

/** Static mishear table: "tea mux" → "tmux", "tmux write" → "tmux right", … */
export const NORMALISE_RULES: NormaliseRule[] = [
  [/\btea\s+mux\b/g, "tmux"],
  [/\bt\s+mux\b/g, "tmux"],
  [/\btymo?x\b/g, "tmux"],
  [/\bt-mux\b/g, "tmux"],
  [/\b(?:tee|team|ti|tim)\s*-?mux\b/g, "tmux"],
  [/\bteamucks\b/g, "tmux"],
  // "tmux left/right" is short and whisper splits it into real words:
  // "too much left", "tea much right", "teammates left", "two mouse left",
  // "two months left", "two mux up", … Only at the start of an utterance and
  // only when a tmux sub-command follows (plus at most two more words), so
  // "two months left of my contract" or "too much" on its own is untouched.
  [
    /^(?:(?:too|two|to|tea|tee|team|tim|tu)\s*-?\s*(?:much|mutch|mux|mucks|mox|mouse|months|month|max|mix|marks|mocks|mugs)|teammates?|tumux|timux|tmax|teamux|teemux|tmucks|demux)\b(?=\s+(?:left|lift|laughed|right|write|rite|up|down|zoom|tab|tabs|pane|pain|split|resize|grow|new|next|previous|prev|last|copy|interrupt|go)(?:\s+\S+){0,2}\s*$)/,
    "tmux",
  ],
  [/^tmux\s+(?:write|rite|wright|bright|righ)$/, "tmux right"],
  [/^tmux\s+(?:lift|laughed|lefts?|leaf|loft)$/, "tmux left"],
  [/\btmux\s+(?:tap|tad|tabs)\b/g, "tmux tab"],
  [/\btmux\s+(?:pain|pained)\b/g, "tmux pane"],
];

/** Spoken last word → canonical tmux sub-command. */
const SUBCOMMANDS: Record<string, string> = {
  left: "left", lift: "left", laughed: "left", love: "left", loved: "left", lefts: "left",
  leaf: "left", loft: "left", lest: "left", laugh: "left", lives: "left", life: "left",
  right: "right", write: "right", rite: "right", wright: "right", bright: "right",
  ride: "right", rights: "right", writes: "right", alright: "right", light: "right",
  up: "up", op: "up", hop: "up", pup: "up", ups: "up",
  down: "down", dawn: "down", town: "down", downs: "down", dan: "down", done: "down",
  zoom: "zoom", zoomed: "zoom", zooms: "zoom", room: "zoom", doom: "zoom",
};

/** Single words whisper uses for the whole of "tmux". */
const WHOLE_WORD_TMUX = /^(?:tmux|t-?mux|teammates?|tmarks?|tmax|tmix|tumux|timux|teamux|teemux|tmucks|demux|temux|tmox|teamax|teamix|termux|timex|tamux|tomux|dmux)$/;
/** First word of a two-word "tmux": t/d sounds and numbers ("15 months"). */
const FIRST_HALF = /^(?:t|tea|tee|team|teen|tim|tom|tu|to|too|two|2|ten|10|1[0-9]|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dee)$/;
/** Second word: an "m…" syllable — much, mux, months, max, marks, mouse, … */
const SECOND_HALF = /^(?:mux|much|mutch|mucks|mox|mocks|mouse|months?|max|mix|marks?|mugs?|mac|macs|mike|mikes|mooks|mucus|mus|mutts?|mods?|mops?)$/;

export interface RecoveredIntent {
  /** Canonical command text, e.g. "tmux left". */
  text: string;
  /** The misheard prefix as spoken ("too much"), used for learning. */
  heardPrefix: string;
  /** high = known mishear (or learned); low = fuzzy guess. */
  confidence: "high" | "low";
  /** The prefix was confirmed by the user before. */
  learned: boolean;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Does `text` sound like "tmux <left|right|up|down|zoom>"? Only short
 * utterances (2–3 words) qualify, so real sentences are never rewritten.
 */
export function inferTmuxIntent(text: string, learned: LearnedStore): RecoveredIntent | undefined {
  const w = words(text);
  if (w.length < 2 || w.length > 3) return undefined;
  const sub = SUBCOMMANDS[w[w.length - 1]];
  if (!sub) return undefined;
  const prefixWords = w.slice(0, -1);
  const prefix = prefixWords.join(" ");
  if (prefix === "tmux") return undefined; // already canonical; grammar handles it
  const isLearned = learned.has(TMUX_RECOVERER_NAME, prefix);
  let shape = false;
  let known = false;
  if (prefixWords.length === 1) {
    shape = WHOLE_WORD_TMUX.test(prefixWords[0]);
    known = shape;
  } else if (prefixWords.length === 2) {
    const [a, b] = prefixWords;
    shape = FIRST_HALF.test(a) && SECOND_HALF.test(b);
    // The pairs we've actually seen in logs are trusted more.
    known = shape && /^(?:too|two|to|tea|tee|team)$/.test(a) && /^(?:much|mux|mouse|months|marks|max)$/.test(b);
  }
  if (!shape && !isLearned) return undefined;
  return { text: `tmux ${sub}`, heardPrefix: prefix, confidence: isLearned || known ? "high" : "low", learned: isLearned };
}

/**
 * "tmux" said on its own (or whisper dropped the direction): "tmux.",
 * "tmarks", "team max", "too much". Arms a short follow-up window in which a
 * lone "left"/"down"/… completes the command.
 */
export function isBareTmux(text: string, learned: LearnedStore): boolean {
  const w = words(text);
  if (w.length === 1) return WHOLE_WORD_TMUX.test(w[0]) || learned.has(TMUX_RECOVERER_NAME, w[0]);
  if (w.length === 2) {
    const p = w.join(" ");
    return (FIRST_HALF.test(w[0]) && SECOND_HALF.test(w[1])) || learned.has(TMUX_RECOVERER_NAME, p);
  }
  return false;
}

/** A lone sub-command word ("left.", "love", "down") → canonical, else undefined. */
export function loneSubcommand(text: string): string | undefined {
  const w = words(text);
  return w.length === 1 ? SUBCOMMANDS[w[0]] : undefined;
}

export const TMUX_RECOVERER: IntentRecoverer = {
  name: TMUX_RECOVERER_NAME,
  trustedContext: { apps: TERMINAL_APPS },
  recover({ text }, { learned }): RecoveryResult | undefined {
    // "tmux" on its own (or whisper dropped the direction): wait for a lone direction word.
    if (isBareTmux(text, learned) || /^tmux\.?$/i.test(text.trim())) {
      return {
        kind: "latch",
        ttlMs: TMUX_LATCH_MS,
        message: `[voice] heard bare "tmux" ("${text}") — say left/right/up/down/zoom within ${TMUX_LATCH_MS / 1000}s`,
        complete: (next) => {
          const sub = loneSubcommand(next);
          return sub ? `tmux ${sub}` : undefined;
        },
      };
    }
    const intent = inferTmuxIntent(text, learned);
    if (!intent) return undefined;
    // Only prefixes the user confirmed are "high"; "seen in logs" shapes still ask outside a terminal.
    return { kind: "rewrite", text: intent.text, confidence: intent.learned ? "high" : "low", learnKey: intent.heardPrefix };
  },
};
