/**
 * Intent recovery: the extension point for "Whisper heard something close to a
 * command, can we work out what was meant?".
 *
 * A pack contributes `recoverers`; ONE policy (`RecoveryEngine`) decides what to
 * do with their guesses: run, ask "did you mean …?", or ignore. Recoverers are
 * pure-ish functions of (text, context) — they never run commands or talk to
 * the user themselves.
 */

import type { VoiceServices } from "../services";
import type { LearnedStore } from "./learned";
import type { LatchStore } from "./latch";

/** What a recoverer sees about the utterance. */
export interface RecoveryInput {
  /** The transcript as heard (trimmed). */
  text: string;
  /** `normaliseTranscript(text)` — lowercase, mishear table applied. */
  normalised: string;
  /** Other transcriptions of the same audio (e.g. the unprompted whisper pass). */
  alternatives?: string[];
  /**
   * Set (stage "matched") when the grammar already matched a command and the
   * recoverer may want to sanity-check its slots before it runs.
   */
  match?: { command: string; slots: Record<string, unknown> };
}

export interface RecoveryContext {
  /** Frontmost app, when known. */
  frontApp?: string;
  learned: LearnedStore;
  latch: LatchStore;
  services: VoiceServices;
}

/** A guess: replace the utterance with `text`. */
export interface RewriteResult {
  kind: "rewrite";
  /** Canonical command text to dispatch, e.g. "tmux left". */
  text: string;
  /** high = run without asking; low = ask first (unless context is trusted). */
  confidence: "high" | "low";
  /** What to remember when the user says "yes" (stored under the recoverer's name). */
  learnKey?: string;
  /** Spoken/logged question when asking (default: did you mean "<text>"?). */
  prompt?: string;
  /** Short description of the held action (default: `<text> (heard "<heard>")`). */
  describe?: string;
  /** Called when the engine asks (e.g. to show a desktop notification). */
  onAsk?(): void;
  /** Called when the user declines. */
  onReject?(): void;
}

/** A partial utterance ("tmux" with no direction): wait for the next one. */
export interface LatchResult {
  kind: "latch";
  ttlMs: number;
  /** Next utterance → canonical command text, or undefined when it doesn't complete the latch. */
  complete(nextText: string): string | undefined;
  /** Logged when the latch is armed. */
  message?: string;
}

export type RecoveryResult = RewriteResult | LatchResult;

export interface IntentRecoverer {
  /** Unique name; also the key of this recoverer's entries in the learned store ("tmux", "app-name"). */
  name: string;
  /**
   * "unmatched" (default): runs on utterances no command matched.
   * "matched": runs after a command matched (`input.match` is set), before it runs.
   */
  stage?: "unmatched" | "matched";
  /**
   * Apps/context where this recoverer's guesses are trusted enough to auto-run.
   * Same idea as a command's `context: { app }` — a RegExp or a list of app names.
   */
  trustedContext?: { apps?: RegExp | string[] };
  recover(input: RecoveryInput, ctx: RecoveryContext): RecoveryResult | undefined | Promise<RecoveryResult | undefined>;
  /**
   * Called for every learnKey known at startup and whenever the user confirms
   * a new one — lets a recoverer apply learned data (e.g. add a grammar alias).
   */
  onLearned?(key: string): void;
}
