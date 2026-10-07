import { EventEmitter } from "events";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import {
  ContinuousAudioBackend,
  ContinuousTranscriptSource,
  PcmFrame,
  SoxAudioBackend,
  UtteranceRecognizer,
  summariseNoiseFloor,
} from "../src/continuous";
import {
  appendLatencyRecord,
  buildLatencyRecord,
  formatLatencyLine,
  latencyBreakdown,
} from "../src/latency";
import type { TranscriptEvent, UtteranceTiming } from "../src/types";

const SAMPLE_RATE = 1_000;
const FRAME_MS = 20;

function pcm(value: number): Buffer {
  const result = Buffer.alloc((SAMPLE_RATE * FRAME_MS * 2) / 1_000);
  for (let offset = 0; offset < result.length; offset += 2) result.writeInt16LE(value, offset);
  return result;
}

const clock = { t: 0, now() { return this.t; } };

class Frames implements ContinuousAudioBackend {
  constructor(private readonly values: Array<{ value: number; at: number }>) {}
  async *frames(): AsyncIterable<PcmFrame> {
    for (const item of this.values) {
      clock.t = item.at + FRAME_MS; // frame "arrives" when its last sample is captured
      yield { pcm: pcm(item.value), timestamp: item.at };
    }
  }
}

class SlowRecognizer implements UtteranceRecognizer {
  readonly label = "fake-stt";
  constructor(private readonly text: string, private readonly sttMs: number) {}
  async recognize(): Promise<string> {
    clock.t += this.sttMs;
    return this.text;
  }
}

async function collect(source: ContinuousTranscriptSource): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for await (const e of source.events(new AbortController().signal)) events.push(e);
  return events;
}

describe("transcript.final timing", () => {
  test("records onset, speech end, endpoint, stt and effective silence", async () => {
    const frames = [
      { value: 12_000, at: 1_000 },
      { value: 12_000, at: 1_020 },
      { value: 12_000, at: 1_040 },
      { value: 0, at: 1_060 },
      { value: 0, at: 1_080 },
    ];
    const source = new ContinuousTranscriptSource(
      new Frames(frames),
      new SlowRecognizer("Slice.", 300),
      { sampleRate: SAMPLE_RATE, channels: 1, speechThreshold: 0.05, minSpeechMs: FRAME_MS, silenceMs: 1_000, preRollMs: 0 },
      clock,
    );
    source.setGateMode("command");
    source.setCommandSilenceMs(40);
    expect(source.effectiveSilenceMs()).toBe(40);

    const events = await collect(source);
    const final = events.find((e) => e.type === "transcript.final") as Extract<TranscriptEvent, { type: "transcript.final" }>;
    expect(final.text).toBe("Slice.");
    expect(final.timing).toEqual({
      spokenAt: 1_000,
      speechEndAt: 1_060,
      finalizedAt: 1_100,
      sttStartAt: 1_100,
      sttEndAt: 1_400,
      audioMs: 100,
      voicedMs: 60,
      silenceMs: 40,
      mode: "command",
      sttBackend: "fake-stt",
    });
  });

  test("logs long command-mode utterances and the ambient noise floor", async () => {
    const frames: Array<{ value: number; at: number }> = [];
    for (let i = 0; i < 10; i++) frames.push({ value: 12_000, at: i * FRAME_MS });
    frames.push({ value: 0, at: 200 }, { value: 0, at: 220 });
    const logs: Array<[string, string]> = [];
    const source = new ContinuousTranscriptSource(
      new Frames(frames),
      new SlowRecognizer("keyboard", 1),
      {
        sampleRate: SAMPLE_RATE, channels: 1, speechThreshold: 0.05, minSpeechMs: FRAME_MS,
        silenceMs: 40, preRollMs: 0, maxCommandUtteranceMs: 100, noiseFloorIntervalMs: 100,
      },
      clock,
      (level, message) => logs.push([level, message]),
    );
    source.setGateMode("command");
    source.setCommandSilenceMs(40);
    await collect(source);
    expect(logs.some(([level, m]) => level === "info" && /long command-mode utterance \(240ms audio/.test(m))).toBe(true);
    expect(logs.some(([level, m]) => level === "debug" && /ambient RMS p10/.test(m))).toBe(true);
  });

  test("summariseNoiseFloor percentiles", () => {
    const s = summariseNoiseFloor([0.001, 0.002, 0.003, 0.004, 0.02], 0.012)!;
    expect(s.median).toBe(0.003);
    expect(s.aboveThresholdPct).toBe(20);
    expect(summariseNoiseFloor([], 0.01)).toBeUndefined();
  });
});

describe("latency report", () => {
  const timing: UtteranceTiming = {
    spokenAt: 10_000, speechEndAt: 10_410, finalizedAt: 10_762, sttStartAt: 10_762, sttEndAt: 11_150,
    audioMs: 540, voicedMs: 400, silenceMs: 350, mode: "command", sttBackend: "whisper-server",
    dispatchedAt: 11_159, gazeMs: 3,
  };

  test("breakdown and one-line format", () => {
    expect(latencyBreakdown(timing)).toEqual({ speechMs: 410, endpointMs: 352, queueMs: 0, sttMs: 388, dispatchMs: 9, totalMs: 1159 });
    expect(formatLatencyLine("slice", timing)).toBe(
      "[voice] latency slice: speech 410ms + endpoint 352ms + queue 0ms + stt 388ms + dispatch 9ms = 1159ms (onset→dispatched)" +
        " [whisper-server, gaze 3ms, silence 350ms, audio 540ms]"
    );
  });

  test("appends a JSON line", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "voice-lat-")), "nested", "latency.jsonl");
    await appendLatencyRecord(buildLatencyRecord({ utteranceId: "u", phrase: "slice", source: "dynamic", timing }), file);
    await appendLatencyRecord(buildLatencyRecord({ utteranceId: "v", phrase: "click", source: "builtin", timing }), file);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ phrase: "slice", breakdown: { totalMs: 1159 }, timing: { sttBackend: "whisper-server" } });
  });
});

describe("SoxAudioBackend", () => {
  function fakeChild() {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = jest.fn(() => { child.exitCode = 0; child.stdout.end(); });
    return child;
  }

  test("uses a small SoX buffer and back-dates frames within a burst", async () => {
    const child = fakeChild();
    const spawn = jest.fn(() => child);
    const backend = new SoxAudioBackend({ sampleRate: 16_000, frameMs: 20, spawn, now: () => 100_000 });
    const frames: PcmFrame[] = [];
    const done = (async () => {
      for await (const f of backend.frames(new AbortController().signal)) frames.push(f);
    })();
    // One 60 ms burst = 3 × 20 ms frames (640 bytes each at 16 kHz mono).
    child.stdout.write(Buffer.alloc(640 * 3));
    child.exitCode = 0;
    child.stdout.end();
    await done;
    const args = (spawn.mock.calls[0] as any)[1] as string[];
    expect(args.slice(0, 3)).toEqual(["-q", "--buffer", "1024"]);
    expect(frames.map((f) => f.timestamp)).toEqual([99_940, 99_960, 99_980]);
  });
});
