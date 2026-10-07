/**
 * Regressions from the first live command-mode session (see task notes):
 * broken no_speech_prob gating, prompt-biased "click" on noise, right→left
 * snap, "hello" clicking button 1, greedy chains, "to monitor" → "two monitor".
 */
import { checkVerboseJsonConfidence, isNonSpeechTranscript, unpromptedAgrees } from "../src/whisperServer";
import { parseUtterance } from "../src/grammar";
import { WINDOWS_PACK } from "../src/packs/windows";
import { HINTS_PACK } from "../src/packs/hints";

const commands = [...WINDOWS_PACK, ...HINTS_PACK];

function parse(text: string): string[] {
  const r = parseUtterance(text, commands);
  if (r.kind === "match") return [r.result.command.name];
  if (r.kind === "chain") return r.results.map((x) => x.command.name);
  return [];
}

describe("whisper confidence", () => {
  it("ignores whisper-server's unreliable no_speech_prob", () => {
    expect(checkVerboseJsonConfidence({ text: "smart mouse", segments: [{ text: "smart mouse", no_speech_prob: 0.93, avg_logprob: -0.1 }] }).ok).toBe(true);
  });
  it("still rejects low avg_logprob", () => {
    expect(checkVerboseJsonConfidence({ text: "stop mouse", segments: [{ text: "stop mouse", avg_logprob: -0.9 }] }).ok).toBe(false);
  });
  it("detects non-speech markers", () => {
    expect(isNonSpeechTranscript("[BLANK_AUDIO]")).toBe(true);
    expect(isNonSpeechTranscript(" (silence) ")).toBe(true);
    expect(isNonSpeechTranscript("Click.")).toBe(false);
  });
  it("requires the unprompted pass to agree", () => {
    expect(unpromptedAgrees("click.", "")).toBe(false);
    expect(unpromptedAgrees("click.", "[BLANK_AUDIO]")).toBe(false);
    expect(unpromptedAgrees("click.", "Click.")).toBe(true);
    expect(unpromptedAgrees("smart mouse.", "Smart Mouse.")).toBe(true);
    expect(unpromptedAgrees("click.", "Thank you.")).toBe(false);
  });
});

describe("grammar regressions", () => {
  it("snaps to the side that was said", () => {
    expect(parse("snap chrome monitor 2 right.")).toEqual(["windows.snap-monitor-right"]);
    expect(parse("snap chrome right monitor 2")).toEqual(["windows.snap-monitor-right"]);
    expect(parse("snap chrome monitor two left")).toEqual(["windows.snap-monitor-left"]);
    expect(parse("Snap Chrome Monitor to write.")).toEqual(["windows.snap-monitor-right"]);
  });
  it("never clicks a hint for a plain word", () => {
    expect(parse("hello.")).toEqual([]);
    expect(parse("button 2")).toEqual(["hints.bare-hint"]);
  });
  it("does not greedily chain unmatched speech", () => {
    expect(parse("snap chromeright monitor 2.")).toEqual([]);
  });
  it("keeps 'to' in 'move chrome to monitor 1'", () => {
    expect(parse("move chrome to monitor 1.")).toEqual(["windows.move-to-monitor"]);
    expect(parse("move crown to monitor 1.")).toEqual(["windows.move-to-monitor"]);
  });
  it("accepts an app on maximize", () => {
    expect(parse("maximize chrome.")).toEqual(["windows.maximize"]);
  });
});
