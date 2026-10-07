/**
 * Context-aware recovery of misheard tmux commands (phrases from real logs).
 */

import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  decideRecovery,
  inferTmuxIntent,
  isBareTmux,
  isTerminalApp,
  loneSubcommand,
  LearnedIntents,
} from "../src/intentRecovery";

// Never touch the real ~/.knowhow file: each test gets a store backed by a missing temp file.
let learned: LearnedIntents;
beforeEach(() => {
  learned = new LearnedIntents(join(mkdtempSync(join(tmpdir(), "vc-intent-")), "none.json"));
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
    learned.reset(["tiny marcs"]);
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

describe("decideRecovery", () => {
  const fuzzy = inferTmuxIntent("15 months left", new LearnedIntents(join(tmpdir(), "vc-none.json")))!;
  it("runs when a terminal is frontmost", () => {
    expect(isTerminalApp("Ghostty")).toBe(true);
    expect(isTerminalApp("iTerm2")).toBe(true);
    expect(decideRecovery(fuzzy, "Ghostty", learned, undefined)).toBe("run");
  });
  it("asks to confirm elsewhere", () => {
    expect(decideRecovery(fuzzy, "Google Chrome", learned, undefined)).toBe("confirm");
    expect(decideRecovery(fuzzy, undefined, learned, undefined)).toBe("confirm");
  });
  it("runs learned mishears anywhere", () => {
    learned.reset(["15 months"]);
    expect(decideRecovery(inferTmuxIntent("15 months left", learned)!, "Spotify", learned, undefined)).toBe("run");
  });
  it("honours KNOWHOW_VOICE_INFER", () => {
    expect(decideRecovery(fuzzy, "Ghostty", learned, "off")).toBe("ignore");
    expect(decideRecovery(fuzzy, "Ghostty", learned, "confirm")).toBe("confirm");
    expect(decideRecovery(fuzzy, "Spotify", learned, "auto")).toBe("run");
  });
});

describe("learnTmuxPrefix", () => {
  it("persists confirmed prefixes", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "vc-intent-")), "learned.json");
    const store = new LearnedIntents(file);
    await store.learnTmuxPrefix("15 months");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ tmuxPrefixes: ["15 months"] });
    expect(inferTmuxIntent("15 months up", store)?.confidence).toBe("high");
  });
});
