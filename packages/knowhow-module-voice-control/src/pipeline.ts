/**
 * The utterance pipeline: heard text → normalise → match → recover.
 *
 * ONE implementation shared by the live `VoiceSession` (its unmatched / matched recovery calls are
 * `recoverUtterance`), `voice-control parse` and `voice-control replay` / the replay corpus test
 * (`resolveUtterance`), so the CLI, the tests and the live session cannot disagree.
 *
 *   resolveUtterance("tea mux left", { router, recovery, frontApp: "Ghostty" })
 *     → { kind: "recovered", text: "tmux left", command: "voice-control.tmux.left", … }
 */

import type { ParseResult } from "./grammar";
import { normaliseTranscript } from "./grammar/normalise";
import type { ModeRouter } from "./commandMode";
import type { RecoveryEngine, RecoveryOutcome } from "./recovery/engine";
import type { VoiceMode } from "./types";

export interface RecoverDeps {
  recovery: RecoveryEngine;
  /** Frontmost app, or a lazy lookup (only awaited when a guess needs a trust decision). */
  frontApp?: string | (() => Promise<string | undefined>);
  /** Dispatch a command text (a "yes" to a pending question re-runs the guess through this). */
  run?: (text: string) => Promise<void>;
}

/** Recovery for an utterance (the live session's `recoverUnmatched` / matched-stage check). */
export function recoverUtterance(
  text: string,
  deps: RecoverDeps,
  extra: { alternatives?: string[]; match?: { command: string; slots: Record<string, unknown> } } = {},
): Promise<RecoveryOutcome> {
  return deps.recovery.recover(
    { text, normalised: normaliseTranscript(text), alternatives: extra.alternatives, match: extra.match },
    { frontApp: deps.frontApp, run: deps.run ?? (async () => undefined) },
  );
}

export interface PipelineDeps extends RecoverDeps {
  /** Matches utterances against the registered commands (`ModeRouter.parseRegistered`). */
  router: Pick<ModeRouter, "parseRegistered">;
  mode?: VoiceMode;
  /** Grammar context (gaze-dependent patterns etc.). */
  ctx?: Record<string, unknown>;
}

export type UtteranceKind =
  /** A command matched as heard. */
  | "match"
  /** Several commands chained ("scroll down then click"). */
  | "chain"
  /** Nothing matched as heard; a recoverer rewrote it and the rewrite matches. */
  | "recovered"
  /** A recoverer wants a "yes"/"no" first ("did you mean …?"). */
  | "asked"
  /** A recoverer is waiting for the rest of the utterance (bare "tmux"). */
  | "latched"
  /** Nothing matched and nothing could be recovered. */
  | "none";

export interface UtteranceResolution {
  kind: UtteranceKind;
  heard: string;
  normalised: string;
  /** Name of the (first) command that would run. */
  command?: string;
  /** Its phrase. */
  phrase?: string;
  slots?: Record<string, unknown>;
  repeat?: number;
  /** Every command name of a chain. */
  chain?: string[];
  /** Rewritten text ("recovered") or the proposed text ("asked"). */
  text?: string;
  /** Why it was rewritten / what is being asked. */
  reason?: string;
  parsed?: ParseResult;
}

function describeParse(parsed: ParseResult): Partial<UtteranceResolution> {
  if (parsed.kind === "match") {
    const r = parsed.result;
    return { command: r.command.name, phrase: r.command.phrase, slots: r.slots, repeat: r.repeat };
  }
  if (parsed.kind === "chain") {
    const first = parsed.results[0];
    return {
      command: first.command.name,
      phrase: first.command.phrase,
      slots: first.slots,
      repeat: first.repeat,
      chain: parsed.results.map((r) => r.command.name),
    };
  }
  return {};
}

/**
 * Run `heard` through normalise → match → (matched-stage recovery) → recover → re-match.
 * Pure with respect to commands: nothing is executed.
 */
export async function resolveUtterance(
  heard: string,
  deps: PipelineDeps,
  opts: { alternatives?: string[] } = {},
): Promise<UtteranceResolution> {
  const text = heard.trim();
  const base = { heard: text, normalised: normaliseTranscript(text) };
  const mode = deps.mode ?? "command";
  const parse = (t: string) => deps.router.parseRegistered(t, mode, deps.ctx ?? {});

  let parsed = parse(text);
  if (parsed.kind !== "none") {
    const described = describeParse(parsed);
    // A matched command may still be worth a second look (e.g. a misheard {app} slot).
    const matched = await recoverUtterance(text, deps, { match: { command: described.command!, slots: described.slots ?? {} } });
    if (matched.kind === "handled") {
      return { ...base, kind: "asked", text: matched.asked, reason: "matched-command check", parsed, ...described };
    }
    if (matched.kind === "rewrite") {
      const again = parse(matched.text);
      return { ...base, kind: again.kind === "none" ? "none" : "recovered", text: matched.text, reason: matched.reason, parsed: again, ...describeParse(again) };
    }
    return { ...base, kind: parsed.kind === "chain" ? "chain" : "match", parsed, ...described };
  }

  const outcome = await recoverUtterance(text, deps, { alternatives: opts.alternatives });
  if (outcome.kind === "handled") {
    return outcome.asked
      ? { ...base, kind: "asked", text: outcome.asked, parsed }
      : { ...base, kind: "latched", parsed };
  }
  if (outcome.kind === "rewrite") {
    parsed = parse(outcome.text);
    return {
      ...base,
      kind: parsed.kind === "none" ? "none" : "recovered",
      text: outcome.text,
      reason: outcome.reason,
      parsed,
      ...describeParse(parsed),
    };
  }
  return { ...base, kind: "none", parsed };
}
