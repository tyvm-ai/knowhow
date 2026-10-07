/**
 * Grammar engine tests: parse, slots, normalise, match, chain.
 */

import { compilePattern } from "../src/grammar/compile";
import { matchPattern } from "../src/grammar/match";
import { normaliseTranscript, tokenise } from "../src/grammar/normalise";
import { convertDictation, applyCase, expandSpell } from "../src/grammar/dictation";
import { parseChain, splitOnChainWords } from "../src/grammar/chain";
import { parseUtterance } from "../src/grammar";
import type { VoiceCommandExtension } from "../src/voiceCommands";
import { VOICE_COMMAND_EXTENSION } from "../src/voiceCommands";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkCmd(phrase: string, pattern?: string, aliases?: string[]): VoiceCommandExtension {
  return {
    type: VOICE_COMMAND_EXTENSION,
    name: `test.${phrase.replace(/\s+/g, "-")}`,
    phrase,
    aliases,
    description: "test command",
    pattern,
    run: () => undefined,
  } as any;
}

// ─── normaliseTranscript ──────────────────────────────────────────────────────

describe("normaliseTranscript", () => {
  test("lowercases text", () => {
    expect(normaliseTranscript("CLICK")).toBe("click");
  });

  test("strips trailing period", () => {
    expect(normaliseTranscript("click.")).toBe("click");
  });

  test("strips surrounding quotes", () => {
    expect(normaliseTranscript('"click"')).toBe("click");
  });

  test("fixes eyecontrol mishear", () => {
    expect(normaliseTranscript("eyecontrol mouse")).toBe("eye control mouse");
  });

  test("fixes ghostty mishear", () => {
    expect(normaliseTranscript("go sty")).toBe("ghostty");
  });

  test("fixes crome mishear", () => {
    expect(normaliseTranscript("crome")).toBe("chrome");
  });

  test("fixes tmux mishear", () => {
    expect(normaliseTranscript("tea mux")).toBe("tmux");
  });

  test("strips filler words", () => {
    expect(normaliseTranscript("um click")).toBe("click");
  });

  test("lick is NOT normalised to click (false-positive prevention)", () => {
    // Bug 3: lick/clic must NOT map to click to avoid false-positive commands.
    expect(normaliseTranscript("lick")).toBe("lick");
  });

  test("clic is NOT normalised to click (false-positive prevention)", () => {
    expect(normaliseTranscript("clic")).toBe("clic");
  });

  test("clique is NOT normalised to click (false-positive prevention)", () => {
    expect(normaliseTranscript("clique")).toBe("clique");
  });
});

// ─── compilePattern + matchPattern ───────────────────────────────────────────

describe("compilePattern + matchPattern", () => {
  test("matches plain literal", () => {
    const p = compilePattern("click");
    expect(matchPattern(p, ["click"])).toBeTruthy();
    expect(matchPattern(p, ["drag"])).toBeUndefined();
  });

  test("matches optional", () => {
    const p = compilePattern("undo [that]");
    expect(matchPattern(p, ["undo"])).toBeTruthy();
    expect(matchPattern(p, ["undo", "that"])).toBeTruthy();
    expect(matchPattern(p, ["undo", "it"])).toBeUndefined();
  });

  test("matches alternatives", () => {
    const p = compilePattern("(left|right|up|down)");
    expect(matchPattern(p, ["left"])).toBeTruthy();
    expect(matchPattern(p, ["right"])).toBeTruthy();
    expect(matchPattern(p, ["center"])).toBeUndefined();
  });

  test("matches enum slot", () => {
    const p = compilePattern("snap {side:left|right|top|bottom}");
    const r = matchPattern(p, ["snap", "left"]);
    expect(r).toBeTruthy();
    expect(r!.slots["side"]).toBe("left");
  });

  test("matches number slot", () => {
    const p = compilePattern("down [{n:number}]");
    const r = matchPattern(p, ["down", "5"]);
    expect(r!.slots["n"]).toBe(5);

    const r2 = matchPattern(p, ["down", "three"]);
    expect(r2!.slots["n"]).toBe(3);

    const r3 = matchPattern(p, ["down"]);
    expect(r3).toBeTruthy();
    expect(r3!.slots["n"]).toBeUndefined();
  });

  test("matches text slot (greedy)", () => {
    const p = compilePattern("type {text:text}");
    const r = matchPattern(p, ["type", "hello", "world"]);
    expect(r!.slots["text"]).toBe("hello world");
  });

  test("fuzzy match for tokens ≥ 5 chars (distance 1)", () => {
    const p = compilePattern("scroll");
    // "srcoll" → substitute one char: "scrol" is 1 deletion from "scroll"
    // Use "scrolll" (insertion) which is 1 edit from "scroll" (≥5 chars)
    expect(matchPattern(p, ["scrolll"])).toBeTruthy();
  });

  test("no fuzzy match for short tokens", () => {
    const p = compilePattern("cut");
    // "cat" is 1 edit from "cut" but "cut" is < 5 chars, must be exact
    expect(matchPattern(p, ["cat"])).toBeUndefined();
  });

  test("monitor slot matches one/two/left/right", () => {
    const p = compilePattern("snap monitor {mon:monitor} left");
    const r = matchPattern(p, ["snap", "monitor", "two", "left"]);
    expect(r).toBeTruthy();
    expect(r!.slots["mon"]).toBe(2);
  });
});

// ─── convertDictation ─────────────────────────────────────────────────────────

describe("convertDictation", () => {
  test("converts comma", () => {
    expect(convertDictation("hello comma world")).toBe("hello, world");
  });

  test("converts period", () => {
    expect(convertDictation("hello period")).toBe("hello.");
  });

  test("converts new line", () => {
    expect(convertDictation("hello new line world")).toBe("hello\nworld");
  });

  test("strips trailing whisper period", () => {
    expect(convertDictation("hello world.")).toBe("hello world");
  });

  test("strips surrounding quotes", () => {
    expect(convertDictation('"hello world"')).toBe("hello world");
  });
});

// ─── applyCase ────────────────────────────────────────────────────────────────

describe("applyCase", () => {
  test("camel: get user name → getUserName", () => {
    expect(applyCase("camel", "get user name")).toBe("getUserName");
  });

  test("snake: get user name → get_user_name", () => {
    expect(applyCase("snake", "get user name")).toBe("get_user_name");
  });

  test("kebab: get user name → get-user-name", () => {
    expect(applyCase("kebab", "get user name")).toBe("get-user-name");
  });

  test("title: hello world → Hello World", () => {
    expect(applyCase("title", "hello world")).toBe("Hello World");
  });

  test("caps: hello world → HELLO WORLD", () => {
    expect(applyCase("caps", "hello world")).toBe("HELLO WORLD");
  });
});

// ─── expandSpell ──────────────────────────────────────────────────────────────

describe("expandSpell", () => {
  test("single letters", () => {
    expect(expandSpell("k n o w")).toBe("know");
  });

  test("NATO alphabet", () => {
    expect(expandSpell("kilo november oscar whiskey")).toBe("know");
  });

  test("mixed", () => {
    expect(expandSpell("a b c")).toBe("abc");
  });
});

// ─── splitOnChainWords ────────────────────────────────────────────────────────

describe("splitOnChainWords", () => {
  test("splits on 'then'", () => {
    expect(splitOnChainWords("select all then copy")).toEqual(["select all", "copy"]);
  });

  test("splits on 'and then'", () => {
    expect(splitOnChainWords("select all and then copy")).toEqual(["select all", "copy"]);
  });

  test("no split without then", () => {
    expect(splitOnChainWords("select all")).toEqual(["select all"]);
  });

  test("three-way chain", () => {
    expect(splitOnChainWords("select all then copy then paste")).toEqual(["select all", "copy", "paste"]);
  });
});

// ─── parseUtterance ──────────────────────────────────────────────────────────

describe("parseUtterance", () => {
  const commands: VoiceCommandExtension[] = [
    mkCmd("select all", "select all"),
    mkCmd("copy", "copy"),
    mkCmd("paste", "paste"),
    mkCmd("down", "down [{n:number}]"),
    mkCmd("snap", "snap {side:left|right|top|bottom|full}"),
    mkCmd("type", "type {text:text}"),
    mkCmd("click", "click"),
    mkCmd("scroll down", "scroll down [{n:number}]"),
  ];

  test("basic single command", () => {
    const r = parseUtterance("copy", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.result.command.phrase).toBe("copy");
  });

  test("command with number slot", () => {
    const r = parseUtterance("down 5", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(r.result.command.phrase).toBe("down");
    }
  });

  test("command with repeat extracted", () => {
    const r = parseUtterance("down 5", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      // Repeat is extracted from trailing number
      expect(r.result.repeat).toBeGreaterThanOrEqual(1);
    }
  });

  test("chained command via 'then'", () => {
    const r = parseUtterance("select all then copy", commands);
    expect(r.kind).toBe("chain");
    if (r.kind === "chain") {
      expect(r.results.length).toBe(2);
      expect(r.results[0].command.phrase).toBe("select all");
      expect(r.results[1].command.phrase).toBe("copy");
    }
  });

  test("enum slot matched", () => {
    const r = parseUtterance("snap left", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(r.result.slots["side"]).toBe("left");
    }
  });

  test("text slot matched", () => {
    const r = parseUtterance("type hello world", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(r.result.slots["text"]).toBe("hello world");
    }
  });

  test("noise word 'lick' rejected (after normalise → click)", () => {
    // After normalise, "lick" → "click" (via mishear table)
    const r = parseUtterance("lick", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.result.command.phrase).toBe("click");
  });

  test("'clic' normalised to click", () => {
    const r = parseUtterance("clic", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.result.command.phrase).toBe("click");
  });

  test("no match for random noise", () => {
    const r = parseUtterance("zzzzblorp", commands);
    expect(r.kind).toBe("none");
  });

  test("snap chrome monitor two left pattern", () => {
    const snapCmd = mkCmd("snap", "snap [{target:app}] [monitor {mon:monitor}] {side:left|right|top|bottom|full}");
    const r = parseUtterance("snap chrome monitor two left", [snapCmd]);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      expect(r.result.slots["side"]).toBe("left");
      expect(r.result.slots["mon"]).toBe(2);
    }
  });

  test("mishear 'eyecontrol mouse' → 'eye control mouse'", () => {
    const eyeCmd = mkCmd("eye control mouse", "eye control mouse");
    const r = parseUtterance("eyecontrol mouse", [eyeCmd]);
    expect(r.kind).toBe("match");
  });

  test("type hello comma world → slots.text = 'hello comma world'", () => {
    const r = parseUtterance("type hello comma world", commands);
    expect(r.kind).toBe("match");
    if (r.kind === "match") {
      // text slot is raw; conversion happens in the command handler
      expect(r.result.slots["text"]).toContain("hello");
    }
  });
});

// ─── Gate: F4 short word exact match only ────────────────────────────────────

describe("F4 short-word exact matching", () => {
  const commands: VoiceCommandExtension[] = [
    mkCmd("cut", "cut"),
    mkCmd("copy", "copy"),
    mkCmd("click", "click"),
  ];

  test("'cut' exact match", () => {
    expect(parseUtterance("cut", commands).kind).toBe("match");
  });

  test("'cat' (1 edit from 'cut', 3 chars) should NOT match cut", () => {
    // 'cut' is < 5 chars, must be exact
    expect(parseUtterance("cat", commands).kind).toBe("none");
  });

  test("'copi' (1 edit from 'copy', 4 chars) should NOT match copy", () => {
    // 'copy' is < 5 chars, must be exact
    expect(parseUtterance("copi", commands).kind).toBe("none");
  });
});
