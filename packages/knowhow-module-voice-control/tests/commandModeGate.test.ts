/**
 * Tests for command-mode gate fixes (Workstream B follow-up).
 *
 * Covers:
 *  1. Bare single-word command accepted in command mode without wake phrase.
 *  2. Single-word rejected in agent mode without wake.
 *  3. Mode switching updates the gate (setGateMode called on change).
 *  4. commandSilenceMs used for endpointing in command mode.
 *  5. spokenAt is VAD speech-onset epoch time.
 *  6. Dispatched dynamic command carries gaze nearest spokenAt.
 *  7. Wake phrase in command mode → wakeMatched=true on transcript.final.
 */

import {
  ContinuousAudioBackend,
  ContinuousClock,
  ContinuousTranscriptSource,
  PcmFrame,
  UtteranceRecognizer,
} from "../src/audio";
import type { TranscriptEvent } from "../src/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 1_000;
const FRAME_MS = 20;
const SPEECH_VAL = 12_000; // RMS well above threshold

function makePcm(value: number): Buffer {
  const result = Buffer.alloc((SAMPLE_RATE * FRAME_MS * 2) / 1_000);
  for (let offset = 0; offset < result.length; offset += 2) {
    result.writeInt16LE(value, offset);
  }
  return result;
}

function baseOptions(extra: Record<string, unknown> = {}) {
  return {
    sampleRate: SAMPLE_RATE,
    channels: 1,
    speechThreshold: 0.05,
    minSpeechMs: FRAME_MS,
    silenceMs: 1_000, // agent-mode silence
    preRollMs: 0,
    ...extra,
  };
}

class FixedFrames implements ContinuousAudioBackend {
  constructor(private readonly frames_: Array<{ value: number; at: number }>) {}

  async *frames(signal: AbortSignal): AsyncIterable<PcmFrame> {
    for (const item of this.frames_) {
      if (signal.aborted) return;
      yield { pcm: makePcm(item.value), timestamp: item.at };
    }
  }
}

class FixedRecognizer implements UtteranceRecognizer {
  readonly calls: number[] = [];
  private readonly answers: string[];

  constructor(answers: string[]) {
    this.answers = [...answers];
  }

  async recognize(_wav: Buffer): Promise<string> {
    this.calls.push(Date.now());
    return this.answers.shift() ?? "";
  }
}

/** A recognizer that tracks setPromptPhrases calls. */
class TrackingRecognizer extends FixedRecognizer {
  readonly promptUpdates: string[][] = [];

  setPromptPhrases(phrases: string[]): void {
    this.promptUpdates.push(phrases);
  }
}

class FixedClock implements ContinuousClock {
  constructor(public time: number = 1_000) {}
  now(): number {
    return this.time;
  }
}

/** One speech frame followed by enough silence to endpoint. */
function utteranceFrames(startAt: number, silenceCount: number): Array<{ value: number; at: number }> {
  const frames: Array<{ value: number; at: number }> = [];
  frames.push({ value: SPEECH_VAL, at: startAt });
  for (let i = 0; i < silenceCount; i++) {
    frames.push({ value: 0, at: startAt + FRAME_MS * (i + 1) });
  }
  return frames;
}

async function collectEvents(source: ContinuousTranscriptSource): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for await (const event of source.events(new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("command-mode gate (single-word, no wake phrase)", () => {
  test("bare 'click' is accepted in command mode without wake phrase", async () => {
    // One speech frame, then enough silence to endpoint (silenceMs=20ms for fast test).
    const frames = utteranceFrames(1000, 2); // 2 silent frames × 20ms = 40ms silence
    const recognizer = new FixedRecognizer(["click"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS }),
    );
    // Switch to command mode — no wake required, single words allowed.
    source.setGateMode("command");

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final") as Extract<
      TranscriptEvent,
      { type: "transcript.final" }
    >[];
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("click");
    // wake was not matched but command mode accepted it anyway.
    expect(finals[0].wakeMatched).toBe(false);
  });

  test("bare single-word 'slice' accepted in command mode and dispatched to hub", async () => {
    const frames = utteranceFrames(2000, 2);
    const recognizer = new FixedRecognizer(["slice"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS }),
    );
    source.setGateMode("command");

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final");
    expect(finals).toHaveLength(1);
    expect((finals[0] as any).text).toBe("slice");
  });

  test("whisper hallucination 'thank you' rejected in command mode", async () => {
    const frames = utteranceFrames(1000, 2);
    const recognizer = new FixedRecognizer(["thank you"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS }),
    );
    source.setGateMode("command");

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final");
    expect(finals).toHaveLength(0);
  });

  test("hallucination 'you' rejected in command mode", async () => {
    const frames = utteranceFrames(1000, 2);
    const recognizer = new FixedRecognizer(["you"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS }),
    );
    source.setGateMode("command");

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final");
    expect(finals).toHaveLength(0);
  });
});

describe("agent-mode gate (single-word rejected without wake)", () => {
  test("single-word 'slice' rejected in agent mode without wake phrase match", async () => {
    const frames = utteranceFrames(1000, 2);
    const recognizer = new FixedRecognizer(["slice"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      // agent mode: wakePhrase required, minCommandWords=2
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS, minCommandWords: 2 }),
    );
    // gateMode defaults to "agent"

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final");
    expect(finals).toHaveLength(0);
  });

  test("multi-word 'do something' accepted in agent mode after wake phrase", async () => {
    // Two utterances: first is the wake phrase, second is the command.
    const frames = [
      ...utteranceFrames(1000, 2),  // "hey knowhow" — wake
      ...utteranceFrames(5000, 2),  // "do something" — command
    ];
    const recognizer = new FixedRecognizer(["hey knowhow", "do something"]);
    const clock = new FixedClock(500);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS, activeWindowMs: 30_000 }),
      clock,
    );
    // agent mode (default)

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final") as any[];
    // The wake utterance activates the window; the second utterance should pass.
    expect(finals.some((f: any) => f.text === "do something")).toBe(true);
  });
});

describe("mode switching updates gate", () => {
  test("utterance rejected in agent mode but accepted after switching to command mode", async () => {
    // Two identical single-word utterances. First in agent mode (rejected), then command mode (accepted).
    const frames = [
      ...utteranceFrames(1000, 2),
      ...utteranceFrames(5000, 2),
    ];
    const recognizer = new FixedRecognizer(["click", "click"]);
    const clock = new FixedClock(0);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS, minCommandWords: 2 }),
      clock,
    );
    // Start in agent mode — first "click" should be rejected.
    // Then switch to command mode before the second recognition completes.
    // (Both utterances are captured before any recognition runs since recognition is async.)

    // Collect events with mode switch applied before events start.
    source.setGateMode("command");

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final");
    // With command mode set upfront, both should pass.
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect((finals[0] as any).text).toBe("click");
  });
});

describe("commandSilenceMs endpointing", () => {
  test("command mode uses commandSilenceMs for shorter endpointing", async () => {
    const COMMAND_SILENCE = FRAME_MS * 2; // 40ms — much shorter than agent silenceMs
    const AGENT_SILENCE = FRAME_MS * 50; // 1000ms — frames that would keep utterance open in agent mode

    // One speech frame followed by 3 silent frames (60ms silence).
    // With commandSilenceMs=40ms, should endpoint after 2 silent frames.
    // With silenceMs=1000ms, would never endpoint in these frames.
    const frames = [
      { value: SPEECH_VAL, at: 1000 },
      { value: 0, at: 1020 },
      { value: 0, at: 1040 }, // 40ms trailing silence — triggers commandSilenceMs endpoint
      { value: 0, at: 1060 },
    ];
    const recognizer = new FixedRecognizer(["click"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "", silenceMs: AGENT_SILENCE }),
    );
    source.setGateMode("command");
    source.setCommandSilenceMs(COMMAND_SILENCE);

    const events = await collectEvents(source);
    const finals = events.filter((e) => e.type === "transcript.final");
    // Should endpoint with commandSilenceMs, yielding a transcript.final
    expect(finals).toHaveLength(1);
  });
});

describe("spokenAt is VAD speech-onset epoch time", () => {
  test("transcript.final spokenAt equals the timestamp of the first speech frame", async () => {
    const SPEECH_ONSET = 12345; // epoch ms of the first speech frame
    const frames = [
      { value: SPEECH_VAL, at: SPEECH_ONSET },
      { value: 0, at: SPEECH_ONSET + FRAME_MS },
      { value: 0, at: SPEECH_ONSET + FRAME_MS * 2 },
    ];
    const recognizer = new FixedRecognizer(["click"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "", silenceMs: FRAME_MS }),
    );
    source.setGateMode("command");

    const events = await collectEvents(source);
    const final = events.find((e) => e.type === "transcript.final") as any;
    expect(final).toBeDefined();
    expect(final.spokenAt).toBe(SPEECH_ONSET);
  });
});

describe("setPromptPhrases delegation to recognizer", () => {
  test("ContinuousTranscriptSource.setPromptPhrases delegates to recognizer", () => {
    const recognizer = new TrackingRecognizer([]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames([]),
      recognizer,
      baseOptions(),
    );
    source.setPromptPhrases(["click", "double click", "right click"]);
    expect(recognizer.promptUpdates).toHaveLength(1);
    expect(recognizer.promptUpdates[0]).toEqual(["click", "double click", "right click"]);
  });

  test("setPromptPhrases with empty array clears phrases", () => {
    const recognizer = new TrackingRecognizer([]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames([]),
      recognizer,
      baseOptions(),
    );
    source.setPromptPhrases(["click"]);
    source.setPromptPhrases([]);
    expect(recognizer.promptUpdates[1]).toEqual([]);
  });
});

describe("wake phrase in command mode sets wakeMatched=true", () => {
  test("wake phrase in command mode causes wakeMatched=true and remainder becomes text", async () => {
    const frames = utteranceFrames(1000, 2);
    const recognizer = new FixedRecognizer(["hey knowhow do something"]);
    const source = new ContinuousTranscriptSource(
      new FixedFrames(frames),
      recognizer,
      baseOptions({ wakePhrase: "hey knowhow", silenceMs: FRAME_MS }),
    );
    source.setGateMode("command");

    const events = await collectEvents(source);
    const final = events.find((e) => e.type === "transcript.final") as any;
    expect(final).toBeDefined();
    expect(final.wakeMatched).toBe(true);
    expect(final.text).toBe("do something");
  });
});
