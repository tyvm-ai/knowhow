/**
 * Utterance replay: run recorded / hand-written utterances through the same pipeline as the live session
 * and compare with what we expect.
 *
 *   {"heard":"tea mux left","frontApp":"Ghostty","expected":{"command":"voice-control.tmux.left","recovered":"tmux left"}}
 *
 * Corpus rows live in `tests/fixtures/utterances/*.jsonl` (one JSON object per line). `voice-control replay
 * <file>` runs a corpus or a `commands.jsonl` decision log; `--export` turns a decision log into corpus rows.
 */

import { readFileSync } from "fs";
import { ModeRouter } from "./commandMode";
import type { CommandDecisionRecord } from "./commandLog";
import { createVoiceServices, createMemoryLogger } from "./services";
import type { VoiceServices } from "./services";
import { LearnedStore } from "./recovery/learned";
import { RecoveryEngine, collectRecoverers } from "./recovery/engine";
import { registerPackNormalisers } from "./packs/define";
import type { AnyVoicePack } from "./packs/define";
import { allPacks } from "./packs/index";
import { resolveUtterance } from "./pipeline";
import type { UtteranceResolution } from "./pipeline";
import type { PlatformActions } from "./actions/types";
import { collectVoiceCommands } from "./voiceCommands";
import type { RegisteredVoiceCommand } from "./voiceCommands";

export interface CorpusExpectation {
  /** Name of the command that should run (after any recovery). */
  command?: string;
  /** Subset of the slots the command should get. */
  slots?: Record<string, unknown>;
  /** The text a recoverer should rewrite the utterance to (the row is "recovered"). */
  recovered?: string;
  /** Nothing should run: `true` = no match, "asked" = a confirmation question, "latched" = waiting for more. */
  rejected?: boolean | "asked" | "latched";
}

export interface CorpusRow {
  heard: string;
  /** Other transcriptions of the same audio. */
  alternatives?: string[];
  frontApp?: string;
  /** Running apps (for app-name suggestions). */
  runningApps?: string[];
  /** Earlier utterances of the same session, replayed first (e.g. a bare "tmux" arming a latch). */
  previous?: string[];
  expected: CorpusExpectation;
  /** Free-form note shown in failures. */
  note?: string;
}

export interface ReplayDeps {
  commands: readonly RegisteredVoiceCommand[];
  packs: readonly AnyVoicePack[];
}

/** The commands and packs of a live session (shipped packs; knowhow.json commands are left out so replays are reproducible). */
export function defaultReplayDeps(packs: readonly AnyVoicePack[] = allPacks()): ReplayDeps {
  registerPackNormalisers(packs);
  return {
    packs,
    commands: collectVoiceCommands({ config: {}, builtins: [], moduleExtensions: packs.flatMap((p) => p.extensions).map((extension) => ({ owner: "voice-control", extension })) }),
  };
}

/** Fresh, side-effect-free services for one replayed session. */
function replayServices(row: Pick<CorpusRow, "frontApp" | "runningApps">): VoiceServices {
  const platform = {
    frontmostApp: async () => row.frontApp,
    listRunningApps: async () => row.runningApps ?? [],
  } as unknown as PlatformActions;
  return createVoiceServices({
    platform,
    computer: undefined,
    learned: new LearnedStore({ persist: false, file: "/dev/null", legacyIntentsFile: null, legacyAppAliasesFile: null }),
    log: createMemoryLogger("silent"),
  });
}

export interface RowResult {
  row: CorpusRow;
  actual: UtteranceResolution;
  ok: boolean;
  /** Why it differs (empty when ok). */
  problems: string[];
}

function isSubset(expected: Record<string, unknown>, actual: Record<string, unknown> | undefined): boolean {
  return Object.entries(expected).every(([k, v]) => JSON.stringify(actual?.[k]) === JSON.stringify(v));
}

export function checkRow(row: CorpusRow, actual: UtteranceResolution): string[] {
  const e = row.expected ?? {};
  const problems: string[] = [];
  if (e.rejected) {
    const want = e.rejected === true ? "none" : e.rejected;
    if (actual.kind !== want) problems.push(`expected ${want}, got ${actual.kind}${actual.command ? ` (${actual.command})` : ""}`);
    return problems;
  }
  if (e.command !== undefined && actual.command !== e.command) {
    problems.push(`expected command ${e.command}, got ${actual.command ?? actual.kind}`);
  }
  if (e.slots && !isSubset(e.slots, actual.slots)) {
    problems.push(`expected slots ⊇ ${JSON.stringify(e.slots)}, got ${JSON.stringify(actual.slots ?? {})}`);
  }
  if (e.recovered !== undefined) {
    if (actual.kind !== "recovered") problems.push(`expected a recovery to "${e.recovered}", got ${actual.kind}`);
    else if (actual.text !== e.recovered) problems.push(`expected recovery "${e.recovered}", got "${actual.text}"`);
  } else if (e.command !== undefined && actual.kind === "recovered") {
    problems.push(`expected a direct match, but it needed a recovery to "${actual.text}"`);
  }
  return problems;
}

/** Replay one row in its own session (fresh services, recovery engine, latch). */
export async function replayRow(row: CorpusRow, deps: ReplayDeps = defaultReplayDeps()): Promise<RowResult> {
  const services = replayServices(row);
  const recovery = new RecoveryEngine({ recoverers: collectRecoverers(deps.packs), services, log: () => undefined });
  const router = new ModeRouter({ commands: [...deps.commands] });
  const pipeline = { router, recovery, frontApp: row.frontApp };
  for (const earlier of row.previous ?? []) await resolveUtterance(earlier, pipeline);
  const actual = await resolveUtterance(row.heard, pipeline, { alternatives: row.alternatives });
  const problems = checkRow(row, actual);
  return { row, actual, ok: problems.length === 0, problems };
}

export async function replayCorpus(rows: readonly CorpusRow[], deps: ReplayDeps = defaultReplayDeps()): Promise<RowResult[]> {
  const out: RowResult[] = [];
  for (const row of rows) out.push(await replayRow(row, deps));
  return out;
}

/** Parse JSON Lines (blank lines and `//` comment lines are skipped). */
export function parseJsonl<T>(text: string, source = "jsonl"): T[] {
  const out: T[] = [];
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("//")) return;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      throw new Error(`${source}:${i + 1}: not valid JSON`);
    }
  });
  return out;
}

export function loadCorpusFile(path: string): CorpusRow[] {
  return parseJsonl<CorpusRow>(readFileSync(path, "utf8"), path);
}

function isDecisionRecord(v: unknown): v is CommandDecisionRecord {
  const r = v as Partial<CommandDecisionRecord>;
  return !!r && typeof r.text === "string" && (r.decision === "accepted" || r.decision === "rejected") && !("heard" in (v as object));
}

/**
 * Turn `commands.jsonl` decision records (see commandLog.ts) into corpus rows: an accepted phrase becomes
 * `expected.command` (found by phrase in `commands`), a rejected one becomes `expected.rejected`.
 * Records whose phrase isn't a known command are skipped; duplicates (same heard + expectation) are dropped.
 */
export function decisionsToCorpus(records: readonly CommandDecisionRecord[], commands: readonly RegisteredVoiceCommand[]): CorpusRow[] {
  const byPhrase = new Map<string, RegisteredVoiceCommand>();
  for (const c of commands) {
    byPhrase.set(c.phrase.toLowerCase(), c);
    for (const a of c.aliases ?? []) if (!byPhrase.has(a.toLowerCase())) byPhrase.set(a.toLowerCase(), c);
  }
  const seen = new Set<string>();
  const rows: CorpusRow[] = [];
  for (const r of records) {
    let expected: CorpusExpectation | undefined;
    if (r.decision === "accepted") {
      const cmd = r.phrase ? byPhrase.get(r.phrase.toLowerCase()) : undefined;
      if (cmd) expected = { command: cmd.name };
    } else if (r.rejectedReason?.startsWith("awaiting-confirm")) {
      expected = { rejected: "asked" };
    } else {
      expected = { rejected: true };
    }
    if (!expected) continue;
    const key = `${r.text}\u0000${JSON.stringify(expected)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ heard: r.text, expected, note: `from decision log${r.rejectedReason ? ` (${r.rejectedReason})` : ""}` });
  }
  return rows;
}

export type ReplayInput =
  | { kind: "corpus"; rows: CorpusRow[] }
  | { kind: "decisions"; records: CommandDecisionRecord[] };

/** Load a file that is either a corpus or a `commands.jsonl` decision log. */
export function loadReplayInput(path: string): ReplayInput {
  const items = parseJsonl<Record<string, unknown>>(readFileSync(path, "utf8"), path);
  if (items.length && items.every(isDecisionRecord)) return { kind: "decisions", records: items as unknown as CommandDecisionRecord[] };
  return { kind: "corpus", rows: items as unknown as CorpusRow[] };
}

export function formatRowResult(r: RowResult): string {
  const what = r.actual.kind === "recovered"
    ? `${r.actual.command ?? "-"} (recovered → "${r.actual.text}")`
    : r.actual.kind === "match" || r.actual.kind === "chain"
      ? r.actual.command ?? "-"
      : r.actual.kind;
  return `${r.ok ? "ok  " : "FAIL"}  "${r.row.heard}"${r.row.frontApp ? ` [${r.row.frontApp}]` : ""} → ${what}${r.problems.length ? `\n        ${r.problems.join("\n        ")}` : ""}`;
}

/**
 * `voice-control replay <file>`: run a corpus (or a decision log: each recorded text is re-run and compared with
 * what happened then) and print a report. Returns the number of failing rows.
 */
export async function runReplayCli(
  file: string,
  opts: { json?: boolean; exportCorpus?: boolean; deps?: ReplayDeps; write?: (text: string) => void } = {},
): Promise<number> {
  const write = opts.write ?? ((text: string) => void process.stdout.write(text));
  const deps = opts.deps ?? defaultReplayDeps();
  const input = loadReplayInput(file);
  if (input.kind === "decisions" && opts.exportCorpus) {
    for (const row of decisionsToCorpus(input.records, deps.commands)) write(JSON.stringify(row) + "\n");
    return 0;
  }
  const rows = input.kind === "corpus" ? input.rows : decisionsToCorpus(input.records, deps.commands);
  const results = await replayCorpus(rows, deps);
  const failed = results.filter((r) => !r.ok);
  if (opts.json) {
    write(JSON.stringify(results.map((r) => ({ heard: r.row.heard, ok: r.ok, problems: r.problems, actual: { ...r.actual, parsed: undefined } })), null, 2) + "\n");
  } else {
    for (const r of results) if (!r.ok || results.length <= 50) write(formatRowResult(r) + "\n");
    write(`\n${results.length - failed.length}/${results.length} utterances behave as expected${input.kind === "decisions" ? " (compared with the decision log)" : ""}.\n`);
  }
  return failed.length;
}
