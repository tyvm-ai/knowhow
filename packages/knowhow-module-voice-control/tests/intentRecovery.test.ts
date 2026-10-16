/**
 * Context-aware recovery of misheard tmux commands (phrases from real logs):
 * the tmux heuristics plus the tmux recoverer run through the RecoveryEngine.
 */

import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inferTmuxIntent, isBareTmux, isTerminalApp, loneSubcommand, TMUX_RECOVERER } from "../src/packs/tmuxRecovery";
import { RecoveryEngine } from "../src/recovery/engine";
import type { InferPolicy } from "../src/recovery/engine";
import { LearnedStore } from "../src/recovery/learned";
import { createTestHarness } from "./helpers/services";

// Never touch the real ~/.knowhow files: each test gets a store backed by a missing temp file.
let learned: LearnedStore;
beforeEach(() => {
  learned = new LearnedStore({ file: join(mkdtempSync(join(tmpdir(), "vc-intent-")), "none.json") });
});

describe("inferTmuxIntent", () => {
  it.each([
    ["too much love.", "tmux left"],
    ["15 months left.", "tmux left"],
    ["15 months down.", "tmux down"],
    ["team marks left.", "tmux left"],
    ["Team Max love.", "tmux left"],
    ["teammates right", "tmux right"],
    ["two mouse up", "tmux up"],
    ["tmarks down", "tmux down"],
    ["tea much write", "tmux right"],
  ])("%s → %s", (heard, expected) => {
    expect(inferTmuxIntent(heard, learned)?.text).toBe(expected);
  });

  it.each([
    "two months left of my contract",
    "move left",
    "scroll down",
    "too much",
    "tmux left", // canonical: grammar handles it
    "the max down",
  ])("leaves %s alone", (heard) => {
    expect(inferTmuxIntent(heard, learned)).toBeUndefined();
  });

  it("marks seen-in-logs pairs high and fuzzy ones low", () => {
    expect(inferTmuxIntent("too much left", learned)?.confidence).toBe("high");
    expect(inferTmuxIntent("15 months left", learned)?.confidence).toBe("low");
  });

  it("trusts learned prefixes", () => {
    expect(inferTmuxIntent("tiny marcs left", learned)).toBeUndefined();
    learned.reset({ tmux: ["tiny marcs"] });
    expect(inferTmuxIntent("tiny marcs left", learned)).toMatchObject({ text: "tmux left", confidence: "high" });
  });
});

describe("bare tmux + follow-up", () => {
  it.each(["tmarks", "tmux.", "team max", "too much"])("%s is a bare tmux", (t) => {
    expect(isBareTmux(t, learned)).toBe(true);
  });
  it("is not fooled by ordinary words", () => {
    expect(isBareTmux("thanks", learned)).toBe(false);
    expect(isBareTmux("move it", learned)).toBe(false);
  });
  it("maps lone direction words", () => {
    expect(loneSubcommand("left.")).toBe("left");
    expect(loneSubcommand("love")).toBe("left");
    expect(loneSubcommand("down")).toBe("down");
    expect(loneSubcommand("go left")).toBeUndefined();
  });
});

describe("tmux recoverer through the RecoveryEngine (the old decideRecovery policy)", () => {
  async function recover(
    text: string,
    app: string | undefined,
    opts: { policy?: InferPolicy; seed?: string[] } = {},
  ) {
    const { services } = createTestHarness();
    if (opts.seed) services.learned.reset({ tmux: opts.seed });
    const ran: string[] = [];
    const logs: string[] = [];
    const engine = new RecoveryEngine({ recoverers: [TMUX_RECOVERER], services, log: (l) => logs.push(l) });
    const outcome = await engine.recover(
      { text, normalised: text.toLowerCase() },
      { frontApp: app, run: async (t) => { ran.push(t); }, policy: opts.policy },
    );
    return { outcome, services, ran, logs };
  }

  it("recognises terminal apps", () => {
    expect(isTerminalApp("Ghostty")).toBe(true);
    expect(isTerminalApp("iTerm2")).toBe(true);
    expect(isTerminalApp("Google Chrome")).toBe(false);
  });
  it("runs when a terminal is frontmost", async () => {
    const { outcome, logs } = await recover("15 months left", "Ghostty");
    expect(outcome).toMatchObject({ kind: "rewrite", text: "tmux left" });
    expect(logs[0]).toContain("[voice] inferred:");
  });
  it("asks to confirm elsewhere, and 'yes' runs it and learns the prefix", async () => {
    for (const app of ["Google Chrome", undefined]) {
      const { outcome } = await recover("15 months left", app);
      expect(outcome).toEqual({ kind: "handled", asked: "tmux left" });
    }
    const { services, ran } = await recover("15 months left", "Google Chrome");
    await services.pending.take()!.accept();
    expect(ran).toEqual(["tmux left"]);
    expect(services.learned.has("tmux", "15 months")).toBe(true);
    // learned → trusted anywhere from now on
    const again = new RecoveryEngine({ recoverers: [TMUX_RECOVERER], services, log: () => undefined });
    const out = await again.recover({ text: "15 months up", normalised: "15 months up" }, { frontApp: "Spotify", run: async () => undefined });
    expect(out).toMatchObject({ kind: "rewrite", text: "tmux up" });
  });
  it("runs learned mishears anywhere", async () => {
    const { outcome } = await recover("15 months left", "Spotify", { seed: ["15 months"] });
    expect(outcome).toMatchObject({ kind: "rewrite", text: "tmux left" });
  });
  it("honours KNOWHOW_VOICE_INFER", async () => {
    expect((await recover("15 months left", "Ghostty", { policy: "off" })).outcome).toEqual({ kind: "none" });
    expect((await recover("15 months left", "Ghostty", { policy: "confirm" })).outcome).toMatchObject({ kind: "handled" });
    expect((await recover("15 months left", "Spotify", { policy: "auto" })).outcome).toMatchObject({ kind: "rewrite" });
  });
  it("bare tmux arms a latch; a lone direction completes it", async () => {
    const { services, outcome } = await recover("tmarks", "Google Chrome");
    expect(outcome).toEqual({ kind: "handled" });
    const engine = new RecoveryEngine({ recoverers: [TMUX_RECOVERER], services, log: () => undefined });
    const next = await engine.recover({ text: "left.", normalised: "left" }, { run: async () => undefined });
    expect(next).toMatchObject({ kind: "rewrite", text: "tmux left" });
  });
  it("a bare tmux latch expires", async () => {
    const harness = createTestHarness();
    const engine = new RecoveryEngine({ recoverers: [TMUX_RECOVERER], services: harness.services, log: () => undefined });
    await engine.recover({ text: "tmux.", normalised: "tmux" }, { run: async () => undefined });
    harness.clock.advance(6000);
    const next = await engine.recover({ text: "left", normalised: "left" }, { run: async () => undefined });
    expect(next).toEqual({ kind: "none" });
  });
});

describe("learned store (tmux prefixes)", () => {
  it("persists confirmed prefixes in the shared { recoverer: string[] } shape", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "vc-intent-")), "learned.json");
    const store = new LearnedStore({ file });
    await store.add("tmux", "15 months");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ tmux: ["15 months"] });
    expect(inferTmuxIntent("15 months up", store)?.confidence).toBe("high");
  });
});
