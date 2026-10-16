import {
  ContinuousAudioBackend,
  ContinuousClock,
  ContinuousTranscriptSource,
  PcmFrame,
  UtteranceRecognizer,
  pcmRms,
  pcmToWav,
  preflightContinuousVoice,
} from "../src/audio";
import type { TranscriptEvent } from "../src/types";

const SAMPLE_RATE = 1_000;
const FRAME_MS = 20;

function pcm(value: number): Buffer {
  const result = Buffer.alloc((SAMPLE_RATE * FRAME_MS * 2) / 1_000);
  for (let offset = 0; offset < result.length; offset += 2) {
    result.writeInt16LE(value, offset);
  }
  return result;
}

class Frames implements ContinuousAudioBackend {
  closed = false;

  constructor(
    private readonly values: Array<{ value: number; at: number }>,
    private readonly onFrame?: (timestamp: number) => void
  ) {}

  async *frames(signal: AbortSignal): AsyncIterable<PcmFrame> {
    for (const item of this.values) {
      if (signal.aborted) return;
      this.onFrame?.(item.at);
      yield { pcm: pcm(item.value), timestamp: item.at };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class Answers implements UtteranceRecognizer {
  calls: Buffer[] = [];
  closed = false;

  constructor(private readonly answers: string[]) {}

  async recognize(wav: Buffer): Promise<string> {
    this.calls.push(wav);
    return this.answers.shift() ?? "";
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function utterances(...starts: number[]): Array<{ value: number; at: number }> {
  return starts.flatMap((at) => [
    { value: 12_000, at },
    { value: 0, at: at + FRAME_MS },
  ]);
}

function sourceOptions(extra: Record<string, unknown> = {}) {
  return {
    sampleRate: SAMPLE_RATE,
    channels: 1,
    speechThreshold: 0.05,
    minSpeechMs: FRAME_MS,
    silenceMs: FRAME_MS,
    preRollMs: 0,
    ...extra,
  };
}

async function collect(source: ContinuousTranscriptSource) {
  const events = [];
  for await (const event of source.events(new AbortController().signal)) events.push(event);
  return events;
}

describe("ContinuousTranscriptSource", () => {
  test("uses local VAD for repeated no-Enter utterances", async () => {
    const audio = new Frames(utterances(0, 100));
    const recognizer = new Answers(["first turn", "second turn"]);
    const source = new ContinuousTranscriptSource(
      audio,
      recognizer,
      sourceOptions()
    );

    const events = await collect(source);
    expect(events.map((event) => event.type)).toEqual([
      "speech.started",
      "transcript.partial",
      "transcript.final",
      "speech.started",
      "transcript.partial",
      "transcript.final",
    ]);
    expect(
      events.filter((event) => event.type === "transcript.final").map((event) => event.text)
    ).toEqual(["first turn", "second turn"]);
    expect(recognizer.calls).toHaveLength(2);
    expect(recognizer.calls[0].subarray(0, 4).toString()).toBe("RIFF");
  });

  test("trims endpointing silence before recognition", async () => {
    const frames = [
      { value: 12_000, at: 0 },
      ...Array.from({ length: 10 }, (_, index) => ({
        value: 0,
        at: (index + 1) * FRAME_MS,
      })),
    ];
    const recognizer = new Answers(["one turn"]);
    const source = new ContinuousTranscriptSource(
      new Frames(frames),
      recognizer,
      sourceOptions({ silenceMs: 200 })
    );

    await collect(source);

    const wav = recognizer.calls[0];
    const audioBytes = wav.readUInt32LE(40);
    // One 20ms speech frame plus the retained 120ms tail. The other 80ms of
    // endpointing silence should not be sent to the recognizer.
    expect(audioBytes).toBe((SAMPLE_RATE * 140 * 2) / 1_000);
  });

  test("wake phrase opens a conversational window and expired speech stays gated", async () => {
    let now = 0;
    const clock: ContinuousClock = { now: () => now };
    const audio = new Frames(utterances(0, 100, 180, 500), (at) => {
      now = at;
    });
    const recognizer = new Answers([
      "background conversation",
      "discard these words Hey Knowhow, open mail",
      "show the newest message",
      "this is after the window",
    ]);
    const source = new ContinuousTranscriptSource(
      audio,
      recognizer,
      sourceOptions({ wakePhrase: "hey knowhow", activeWindowMs: 200 }),
      clock
    );

    const events = await collect(source);
    const finals = events.filter((event) => event.type === "transcript.final");

    expect(finals.map((event) => event.text)).toEqual([
      "open mail",
      "show the newest message",
    ]);
    expect(finals.map((event) => event.activation)).toEqual(["wake-word", "wake-word"]);
    expect(events.filter((event) => event.type === "transcript.partial")[0]).toMatchObject({
      text: "background conversation",
    });
    expect(events.filter((event) => event.type === "speech.started")).toHaveLength(2);
    expect(recognizer.calls).toHaveLength(4);
  });

  test("emits active speech onset before final recognition for barge-in", async () => {
    let resolve!: (text: string) => void;
    const answer = new Promise<string>((done) => (resolve = done));
    const recognizer: UtteranceRecognizer = {
      recognize: jest.fn(() => answer),
    };
    const source = new ContinuousTranscriptSource(
      new Frames(utterances(10)),
      recognizer,
      sourceOptions()
    );
    const iterator = source.events(new AbortController().signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "speech.started", timestamp: 10 },
      done: false,
    });
    const final = iterator.next();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((recognizer.recognize as jest.Mock).mock.calls.length) break;
      await new Promise<void>((done) => setImmediate(done));
    }
    expect(recognizer.recognize).toHaveBeenCalledTimes(1);
    resolve("interrupt now");
    await expect(final).resolves.toMatchObject({
      value: { type: "transcript.partial", text: "interrupt now" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "transcript.final", text: "interrupt now" },
    });
  });

  test("continues draining frames while serialized recognition is blocked", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    const calls: Buffer[] = [];
    const recognizer: UtteranceRecognizer = {
      recognize: jest.fn(async (wav: Buffer) => {
        calls.push(wav);
        if (calls.length === 1) await first;
        return calls.length === 1 ? "first" : "second";
      }),
    };
    let frameCount = 0;
    const audio = new Frames(utterances(0, 100), () => (frameCount += 1));
    const source = new ContinuousTranscriptSource(audio, recognizer, sourceOptions());
    const iterator = source.events(new AbortController().signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "speech.started" } });
    for (let attempt = 0; attempt < 10 && frameCount < 4; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(frameCount).toBe(4);
    expect(calls).toHaveLength(1);

    releaseFirst();
    const remaining: TranscriptEvent[] = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      remaining.push(result.value);
    }
    expect(remaining.some((event) => "text" in event && event.text === "first")).toBe(true);
    expect(remaining.some((event) => "text" in event && event.text === "second")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("wake-only utterance activates without entering model context", async () => {
    let now = 0;
    const source = new ContinuousTranscriptSource(
      new Frames(utterances(0, 50), (at) => (now = at)),
      new Answers(["hey knowhow", "continue please"]),
      sourceOptions({ wakePhrase: "hey knowhow", activeWindowMs: 500 }),
      { now: () => now }
    );

    const events = await collect(source);
    expect(events.filter((event) => event.type === "wake.activated")).toMatchObject([
      { phrase: "hey knowhow" },
    ]);
    expect(events.filter((event) => event.type === "transcript.final")).toMatchObject([
      { text: "continue please" },
    ]);
  });

  test.each([
    "bye knowhow",
    "okay we're done",
    "that's all for now",
    "hey knowhow that's enough",
    "stop knowhow",
  ])(
    "returns to wake gating for sleep command: %s",
    async (sleepCommand) => {
      let now = 0;
      const source = new ContinuousTranscriptSource(
        new Frames(utterances(0, 50, 100, 150), (at) => (now = at)),
        new Answers([
          "hey knowhow",
          "do the first thing",
          sleepCommand,
          "this should remain background speech",
        ]),
        sourceOptions({ wakePhrase: "hey knowhow", activeWindowMs: 180_000 }),
        { now: () => now }
      );

      const events = await collect(source);
      expect(events.filter((event) => event.type === "transcript.final")).toMatchObject([
        { text: "do the first thing" },
      ]);
      expect(events.filter((event) => event.type === "wake.deactivated")).toMatchObject([
        { reason: "voice-command" },
      ]);
    }
  );

  test.each(["You. [BLANK_AUDIO]", "[BLANK_AUDIO]", "keyboard clicking [BLANK_AUDIO]"])(
    "strips recognizer artifacts before deciding whether to dispatch: %s",
    async (answer) => {
      const source = new ContinuousTranscriptSource(
        new Frames(utterances(0)),
        new Answers([answer]),
        sourceOptions()
      );

      const events = await collect(source);
      expect(events.filter((event) => event.type === "transcript.final")).toHaveLength(0);
    }
  );

  test("dispatches only the real command before a recognizer artifact", async () => {
    const source = new ContinuousTranscriptSource(
      new Frames(utterances(0)),
      new Answers(["open mail [BLANK_AUDIO]"]),
      sourceOptions()
    );

    const events = await collect(source);
    expect(events.filter((event) => event.type === "transcript.final")).toMatchObject([
      { text: "open mail" },
    ]);
  });

  test("does not dispatch single-word false positives while active", async () => {
    let now = 0;
    const source = new ContinuousTranscriptSource(
      new Frames(utterances(0, 50, 100, 150), (at) => (now = at)),
      new Answers(["hey knowhow", "You", "Yeah", "real request"]),
      sourceOptions({ wakePhrase: "hey knowhow", activeWindowMs: 30_000 }),
      { now: () => now }
    );

    const events = await collect(source);
    expect(events.filter((event) => event.type === "transcript.final")).toMatchObject([
      { text: "real request" },
    ]);
    expect(events.filter((event) => event.type === "transcript.partial")).toHaveLength(4);
  });

  test.each(["", "[BLANK_AUDIO]", "...", "keyboard clicking", "typing noise", "You"]) (
    "does not dispatch non-meaningful recognition output: %s",
    async (answer) => {
      const source = new ContinuousTranscriptSource(
        new Frames(utterances(0)),
        new Answers([answer]),
        sourceOptions({ wakePhrase: "hey knowhow" })
      );

      const events = await collect(source);
      expect(events.filter((event) => event.type === "transcript.final")).toHaveLength(0);
    }
  );

  test("still dispatches a meaningful short command after wake activation", async () => {
    const source = new ContinuousTranscriptSource(
      new Frames(utterances(0)),
      new Answers(["hey knowhow stop"]),
      sourceOptions({ wakePhrase: "hey knowhow" })
    );

    const events = await collect(source);
    expect(events.filter((event) => event.type === "wake.deactivated")).toHaveLength(1);
  });

  test.each(["Hey, no, how? open mail", "Hey, now how? open mail"])(
    "accepts a close wake-phrase transcription: %s",
    async (transcription) => {
      const source = new ContinuousTranscriptSource(
        new Frames(utterances(0)),
        new Answers([transcription]),
        sourceOptions({ wakePhrase: "hey knowhow" })
      );

      const events = await collect(source);
      expect(events.filter((event) => event.type === "transcript.final")).toMatchObject([
        { text: "open mail", activation: "wake-word" },
      ]);
    }
  );

  test("close releases both injected resources", async () => {
    const audio = new Frames([]);
    const recognizer = new Answers([]);
    const source = new ContinuousTranscriptSource(audio, recognizer, sourceOptions());

    await source.close();
    await source.close();

    expect(audio.closed).toBe(true);
    expect(recognizer.closed).toBe(true);
  });

  test("validates RMS and duration options", () => {
    expect(
      () => new ContinuousTranscriptSource(new Frames([]), new Answers([]), {
        speechThreshold: 1.01,
      })
    ).toThrow("0..1");
    expect(
      () => new ContinuousTranscriptSource(new Frames([]), new Answers([]), {
        activeWindowMs: -1,
      })
    ).toThrow("cannot be negative");
  });
});

describe("continuous voice utilities and preflight", () => {
  test("computes PCM energy and produces a valid WAV", () => {
    expect(pcmRms(pcm(0))).toBe(0);
    expect(pcmRms(pcm(16_384))).toBeCloseTo(0.5);
    const wav = pcmToWav(pcm(1), SAMPLE_RATE, 1);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(wav.readUInt32LE(40)).toBe(pcm(1).length);
  });

  test("preflight gives actionable deterministic diagnostics", async () => {
    const diagnostics = await preflightContinuousVoice({
      platform: "darwin",
      captureCommand: "rec",
      recognizerCommand: "whisper-cli",
      commandExists: async (command) => command === "rec",
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "capture.available", level: "info" }),
        expect.objectContaining({ code: "recognizer.missing", level: "error" }),
        expect.objectContaining({
          code: "microphone.permission",
          remedy: expect.stringContaining("System Settings"),
        }),
      ])
    );
  });
});

