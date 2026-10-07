/**
 * Tests for command-mode routing, phrase matching, and mode switching (Contract 4).
 */
import { normalisePhrase, matchPhrase, ModeRouter, BUILTIN_COMMAND_SPECS, buildCommandSttPrompt } from "../src/commandMode";
import type { GazeSample } from "../src/eyeTracking";
import { VoiceCommandSpec } from "../src/voiceHub";

// ─── Phrase normalisation ─────────────────────────────────────────────────────

describe("normalisePhrase", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalisePhrase("Slice!")).toBe("slice");
    expect(normalisePhrase("Eye Control Mouse.")).toBe("eye control mouse");
    expect(normalisePhrase("  double  click  ")).toBe("double click");
  });

  it("collapses multiple spaces", () => {
    expect(normalisePhrase("right   click")).toBe("right click");
  });

  it("handles curly/smart quotes", () => {
    expect(normalisePhrase("don\u2019t")).toBe("don't");
  });
});

// ─── Phrase matching ──────────────────────────────────────────────────────────

const testSpecs: VoiceCommandSpec[] = [
  { phrase: "slice", aliases: [] },
  { phrase: "eye control mouse", aliases: ["gaze mouse", "follow my eyes", "eyecontrol mouse", "i control mouse"] },
  { phrase: "stop mouse", aliases: ["stop eye control"] },
  { phrase: "double click", aliases: ["doubleclick"] },
];

describe("matchPhrase", () => {
  it("exact match", () => {
    const result = matchPhrase("slice", testSpecs);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase).toBe("slice");
  });

  it("case-insensitive", () => {
    const result = matchPhrase("SLICE", testSpecs);
    expect(result.matched).toBe(true);
  });

  it("punctuation stripped", () => {
    const result = matchPhrase("slice!", testSpecs);
    expect(result.matched).toBe(true);
  });

  it("alias match", () => {
    const result = matchPhrase("gaze mouse", testSpecs);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase).toBe("eye control mouse");
  });

  it("concatenated Whisper variant (eyecontrol mouse -> eye control mouse)", () => {
    const result = matchPhrase("eyecontrol mouse", testSpecs);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase).toBe("eye control mouse");
  });

  it("alias: i control mouse -> eye control mouse", () => {
    const result = matchPhrase("i control mouse", testSpecs);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase).toBe("eye control mouse");
  });

  it("alias: doubleclick -> double click", () => {
    const result = matchPhrase("doubleclick", testSpecs);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase).toBe("double click");
  });

  it("fuzzy edit distance: slic -> slice requires exact for short single words", () => {
    // Single-word commands ≤ 6 chars require exact match to prevent false positives
    // (e.g. "lick" must not match "click", "slic" must not match "slice").
    // The F1 audio gate (voicedMs) is the intended mechanism for short-utterance noise rejection.
    const result = matchPhrase("slic", testSpecs);
    expect(result.matched).toBe(false);
  });

  it("no match", () => {
    const result = matchPhrase("completely unrelated words here", testSpecs);
    expect(result.matched).toBe(false);
  });

  it("stop mouse alias", () => {
    const result = matchPhrase("stop eye control", testSpecs);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase).toBe("stop mouse");
  });
});

// ─── Mode router ──────────────────────────────────────────────────────────────

function makeSample(): GazeSample {
  return {
    x: 100, y: 200,
    normalized: { x: 0.5, y: 0.5 },
    confidence: 0.9,
    phase: "live",
    monitor: { x: 0, y: 0, width: 2560, height: 1440 },
    timestamp: Date.now(),
  };
}

describe("ModeRouter", () => {
  it("starts in command mode by default (not tested here — VoiceSession sets initial mode)", () => {
    const router = new ModeRouter();
    expect(router.getMode()).toBe("command");
  });

  describe("detectModeSwitch", () => {
    const router = new ModeRouter();

    it("detects 'command mode'", () => {
      expect(router.detectModeSwitch("command mode")).toBe("command");
    });

    it("detects 'agent mode'", () => {
      expect(router.detectModeSwitch("agent mode")).toBe("agent");
    });

    it("detects 'switch to agent mode'", () => {
      expect(router.detectModeSwitch("switch to agent mode")).toBe("agent");
    });

    it("returns undefined for non-mode text", () => {
      expect(router.detectModeSwitch("slice the fruit")).toBeUndefined();
    });

    it("returns undefined for partial match", () => {
      expect(router.detectModeSwitch("command")).toBeUndefined();
    });
  });

  describe("setMode emits event", () => {
    it("calls onModeChanged when mode changes", () => {
      const changes: string[] = [];
      const router = new ModeRouter({ onModeChanged: (m) => changes.push(m) });
      router.setMode("agent");
      router.setMode("command");
      expect(changes).toEqual(["agent", "command"]);
    });

    it("does not emit when mode unchanged", () => {
      const changes: string[] = [];
      const router = new ModeRouter({ onModeChanged: (m) => changes.push(m) });
      router.setMode("command"); // already command
      expect(changes).toHaveLength(0);
    });
  });

  describe("routeCommandModeUtterance", () => {
    it("matches built-in click command", async () => {
      const builtinCalls: string[] = [];
      const router = new ModeRouter({
        onBuiltinCommand: (phrase) => { builtinCalls.push(phrase); },
      });
      const result = await router.routeCommandModeUtterance("click", "id-1", Date.now(), makeSample());
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.phrase).toBe("click");
        expect(result.source).toBe("builtin");
      }
      expect(builtinCalls).toContain("click");
    });

    it("dynamic commands win over built-ins", async () => {
      const dynamicEvents: string[] = [];
      const router = new ModeRouter({
        onDynamicCommand: (e) => { dynamicEvents.push(e.phrase); },
      });
      router.setDynamicSpecs([{ phrase: "click", aliases: [] }]);
      const result = await router.routeCommandModeUtterance("click", "id-2", Date.now(), undefined);
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.source).toBe("dynamic");
      }
    });

    it("calls onUnmatched for unknown utterance", async () => {
      const unmatched: string[] = [];
      const router = new ModeRouter({ onUnmatched: (t) => unmatched.push(t) });
      const result = await router.routeCommandModeUtterance("something totally random", "id-3", Date.now(), undefined);
      expect(result.matched).toBe(false);
      expect(unmatched).toContain("something totally random");
    });

    it("matches dynamic spec", async () => {
      const dynamicEvents: any[] = [];
      const router = new ModeRouter({
        onDynamicCommand: (e) => dynamicEvents.push(e),
      });
      router.setDynamicSpecs([{ phrase: "slice", aliases: ["slice it"] }]);
      const result = await router.routeCommandModeUtterance("slice", "id-4", Date.now(), makeSample());
      expect(result.matched).toBe(true);
      if (result.matched) expect(result.phrase).toBe("slice");
      expect(dynamicEvents[0].phrase).toBe("slice");
    });
  });

  describe("allPhrases", () => {
    it("includes built-in and dynamic phrases", () => {
      const router = new ModeRouter();
      router.setDynamicSpecs([{ phrase: "slice", aliases: ["slash"] }]);
      const phrases = router.allPhrases();
      expect(phrases).toContain("slice");
      expect(phrases).toContain("slash");
      expect(phrases).toContain("click");
      expect(phrases).toContain("eye control mouse");
    });
  });
});

// ─── STT prompt builder ───────────────────────────────────────────────────────

describe("buildCommandSttPrompt", () => {
  it("includes wake phrase and phrases", () => {
    const prompt = buildCommandSttPrompt(["slice", "click"], "hey knowhow");
    expect(prompt).toContain("hey knowhow");
    expect(prompt).toContain("slice");
    expect(prompt).toContain("click");
  });

  it("works without wake phrase", () => {
    const prompt = buildCommandSttPrompt(["slice"]);
    expect(prompt).toContain("slice");
    expect(prompt).toContain("Knowhow");
  });
});
