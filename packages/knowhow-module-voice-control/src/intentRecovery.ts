/**
 * Context-aware recovery for utterances the grammar couldn't match.
 *
 * Whisper turns the short, made-up word "tmux" into real words almost every
 * time: "too much love", "15 months left", "team marks left", "teammates
 * down". The static mishear table in grammar/normalise.ts catches the common
 * shapes, but there's a long tail. This module:
 *
 *   1. Scores an unmatched utterance for "sounds like tmux <sub-command>"
 *      (fuzzy prefix + a direction/sub-command word at the end).
 *   2. Uses context to decide what to do with it:
 *        - a terminal is frontmost (you're looking at tmux) → just run it
 *        - otherwise → ask: "did you mean tmux left? say yes / no"
 *   3. Learns: when you say "yes", the misheard prefix ("fifteen months") is
 *      saved to ~/.knowhow/voice-learned-intents.json and is trusted from
 *      then on, in any app.
 *
 * KNOWHOW_VOICE_INFER=auto|confirm|off overrides step 2 (auto = run without
 * asking even outside a terminal, confirm = always ask).
 */

import { readFileSync, existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

export const LEARNED_INTENTS_FILE =
  process.env.KNOWHOW_VOICE_LEARNED_INTENTS_FILE ?? join(homedir(), ".knowhow", "voice-learned-intents.json");

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
}

/**
 * The mishearings the user has confirmed ("too much" → tmux), persisted to
 * LEARNED_INTENTS_FILE. One instance per session (`services.intents`);
 * loaded lazily on first use.
 */
export class LearnedIntents {
  private learned: Set<string> | undefined;

  constructor(private readonly file = LEARNED_INTENTS_FILE) {}

  private load(): Set<string> {
    if (this.learned) return this.learned;
    this.learned = new Set();
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as { tmuxPrefixes?: string[] };
        for (const p of data.tmuxPrefixes ?? []) this.learned.add(p.toLowerCase());
      }
    } catch { /* ignore a corrupt file */ }
    return this.learned;
  }

  has(prefix: string): boolean {
    return this.load().has(prefix);
  }

  /** Forget the cached prefixes (optionally seed them) — tests. */
  reset(seed: string[] = []): void {
    this.learned = new Set(seed.map((s) => s.toLowerCase()));
  }

  /** Remember that `prefix` means "tmux" (after the user confirmed it). */
  async learnTmuxPrefix(prefix: string): Promise<void> {
    const p = prefix.toLowerCase().trim();
    if (!p || p === "tmux") return;
    const set = this.load();
    if (set.has(p)) return;
    set.add(p);
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify({ tmuxPrefixes: [...set].sort() }, null, 2) + "\n", "utf8");
    } catch { /* best effort */ }
  }
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Does `text` sound like "tmux <left|right|up|down|zoom>"? Only short
 * utterances (2–3 words) qualify, so real sentences are never rewritten.
 */
export function inferTmuxIntent(text: string, learned: LearnedIntents): RecoveredIntent | undefined {
  const w = words(text);
  if (w.length < 2 || w.length > 3) return undefined;
  const sub = SUBCOMMANDS[w[w.length - 1]];
  if (!sub) return undefined;
  const prefixWords = w.slice(0, -1);
  const prefix = prefixWords.join(" ");
  if (prefix === "tmux") return undefined; // already canonical; grammar handles it
  const isLearned = learned.has(prefix);
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
  return { text: `tmux ${sub}`, heardPrefix: prefix, confidence: isLearned || known ? "high" : "low" };
}

const TERMINAL_APPS = /^(?:ghostty|iterm2?|terminal|wezterm(?:-gui)?|kitty|alacritty|warp|hyper|tabby|rio|wave)$/i;

/**
 * "tmux" said on its own (or whisper dropped the direction): "tmux.",
 * "tmarks", "team max", "too much". Used to arm a short follow-up window in
 * which a lone "left"/"down"/… completes the command.
 */
export function isBareTmux(text: string, learned: LearnedIntents): boolean {
  const w = words(text);
  if (w.length === 1) return WHOLE_WORD_TMUX.test(w[0]) || learned.has(w[0]);
  if (w.length === 2) {
    const p = w.join(" ");
    return (FIRST_HALF.test(w[0]) && SECOND_HALF.test(w[1])) || learned.has(p);
  }
  return false;
}

/** A lone sub-command word ("left.", "love", "down") → canonical, else undefined. */
export function loneSubcommand(text: string): string | undefined {
  const w = words(text);
  return w.length === 1 ? SUBCOMMANDS[w[0]] : undefined;
}

export function isTerminalApp(app: string | undefined): boolean {
  return !!app && TERMINAL_APPS.test(app.trim());
}

export type InferPolicy = "auto" | "confirm" | "off";

export function inferPolicy(env = process.env): InferPolicy | undefined {
  const v = env.KNOWHOW_VOICE_INFER?.toLowerCase().trim();
  return v === "auto" || v === "confirm" || v === "off" ? v : undefined;
}

/**
 * Decide what to do with a recovered intent:
 *   - run: dispatch it now
 *   - confirm: ask the user first
 */
export function decideRecovery(
  intent: RecoveredIntent,
  frontmostApp: string | undefined,
  learned: LearnedIntents,
  policy: InferPolicy | undefined = inferPolicy(),
): "run" | "confirm" | "ignore" {
  if (policy === "off") return "ignore";
  if (policy === "auto") return "run";
  if (policy === "confirm") return "confirm";
  // Default: trust context. Looking at a terminal → it's almost certainly tmux.
  if (isTerminalApp(frontmostApp)) return "run";
  // Learned mishears are trusted anywhere.
  if (intent.confidence === "high" && learned.has(intent.heardPrefix)) return "run";
  return "confirm";
}
