/**
 * Utterance replay corpus: tests/fixtures/utterances/*.jsonl run through the SAME pipeline as the live session
 * (normalise → match → matched-stage check → recover → re-match; src/pipeline.ts).
 *
 * To add a regression: append `{ heard, frontApp?, expected }` to a corpus file (or `voice-control replay --export
 * commands.jsonl` and edit), then `npx jest tests/replayCorpus`.
 */

import { readdirSync } from "fs";
import { join } from "path";
import { defaultReplayDeps, decisionsToCorpus, formatRowResult, loadCorpusFile, parseJsonl, replayRow, runReplayCli } from "../src/replay";
import type { CorpusRow } from "../src/replay";
import type { CommandDecisionRecord } from "../src/commandLog";

const DIR = join(__dirname, "fixtures", "utterances");
const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort();
const deps = defaultReplayDeps();

describe("utterance replay corpus", () => {
  it("has corpus files with rows", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => loadCorpusFile(join(DIR, f))).length).toBeGreaterThan(50);
  });

  for (const file of files) {
    describe(file, () => {
      const rows = loadCorpusFile(join(DIR, file));
      it.each(rows.map((r, i) => [`${i + 1}. ${r.heard}${r.frontApp ? ` [${r.frontApp}]` : ""}`, r] as const))("%s", async (_name, row) => {
        const result = await replayRow(row, deps);
        if (!result.ok) throw new Error(formatRowResult(result));
      });
    });
  }
});

describe("replay helpers", () => {
  it("parseJsonl skips blank lines and // comments, and names the bad line", () => {
    expect(parseJsonl<{ a: number }>('// c\n\n{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonl("{bad", "x.jsonl")).toThrow("x.jsonl:1");
  });

  it("reports what differs", async () => {
    const wrong = await replayRow({ heard: "scroll down", expected: { command: "hints.show" } }, deps);
    expect(wrong.ok).toBe(false);
    expect(wrong.problems[0]).toMatch(/expected command hints\.show, got voice-control\.gaze\.scroll-down/);
    const notRejected = await replayRow({ heard: "scroll down", expected: { rejected: true } }, deps);
    expect(notRejected.ok).toBe(false);
    const needsRecovery = await replayRow({ heard: "too much love.", frontApp: "Ghostty", expected: { command: "voice-control.tmux.pane-left" } }, deps);
    expect(needsRecovery.problems[0]).toMatch(/needed a recovery/);
  });

  it("turns decision-log records into corpus rows (and drops duplicates / unknown phrases)", () => {
    const records: CommandDecisionRecord[] = [
      { ts: 1, utteranceId: "a", text: "scroll down", decision: "accepted", phrase: "scroll down" },
      { ts: 2, utteranceId: "b", text: "scroll down", decision: "accepted", phrase: "scroll down" },
      { ts: 3, utteranceId: "c", text: "blah blah", decision: "rejected", rejectedReason: "no-match" },
      { ts: 4, utteranceId: "d", text: "maximize ghosting", decision: "rejected", rejectedReason: "awaiting-confirm: maximize Ghostty" },
      { ts: 5, utteranceId: "e", text: "something", decision: "accepted", phrase: "not a phrase" },
    ];
    const rows = decisionsToCorpus(records, deps.commands);
    expect(rows.map((r) => [r.heard, r.expected])).toEqual([
      ["scroll down", { command: "voice-control.gaze.scroll-down" }],
      ["blah blah", { rejected: true }],
      ["maximize ghosting", { rejected: "asked" }],
    ]);
  });

  it("runReplayCli replays a corpus file and counts failures; --export prints corpus rows from a decision log", async () => {
    const { mkdtempSync, writeFileSync } = require("fs");
    const { tmpdir } = require("os");
    const dir = mkdtempSync(join(tmpdir(), "vc-replay-"));
    const corpus = join(dir, "corpus.jsonl");
    writeFileSync(corpus, [
      JSON.stringify({ heard: "scroll down", expected: { command: "voice-control.gaze.scroll-down" } }),
      JSON.stringify({ heard: "scroll up", expected: { command: "hints.show" } }),
    ].join("\n"));
    const out: string[] = [];
    expect(await runReplayCli(corpus, { deps, write: (t) => void out.push(t) })).toBe(1);
    expect(out.join("")).toMatch(/FAIL\s+"scroll up"/);
    expect(out.join("")).toMatch(/1\/2 utterances behave as expected/);

    const log = join(dir, "commands.jsonl");
    writeFileSync(log, JSON.stringify({ ts: 1, utteranceId: "a", text: "scroll down", decision: "accepted", phrase: "scroll down" }) + "\n");
    const exported: string[] = [];
    expect(await runReplayCli(log, { deps, exportCorpus: true, write: (t) => void exported.push(t) })).toBe(0);
    const row = JSON.parse(exported.join("").trim()) as CorpusRow;
    expect(row).toMatchObject({ heard: "scroll down", expected: { command: "voice-control.gaze.scroll-down" } });
    // replaying the decision log itself compares the recorded outcome with today's pipeline
    const replayed: string[] = [];
    expect(await runReplayCli(log, { deps, write: (t) => void replayed.push(t) })).toBe(0);
  });
});
