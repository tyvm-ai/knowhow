import { isSpeakableAssistantOutput, VoiceSession } from "../src/VoiceSession";
import {
  ContinuousAudioBackend,
  ContinuousTranscriptSource,
  PcmFrame,
  UtteranceRecognizer,
} from "../src/audio";
import {
  PlaybackHandle,
  SpeechOutput,
  TranscriptEvent,
  TranscriptSource,
  VoiceAgentRuntime,
  VoiceSessionEvent,
} from "../src/types";
import type {
  AgentInput,
  AgentRuntimeEvent,
  InteractiveAgentHandle,
} from "@tyvm/knowhow/sdk";
import { createTestHarness, createTestServices } from "./helpers/services";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
class SequentialRuntime implements VoiceAgentRuntime {
  readonly starts: AgentInput[] = [];
  readonly handles: FakeHandle[] = [];

  async start(options: { initialInput: AgentInput }) {
    this.starts.push(options.initialInput);
    const handle = new FakeHandle();
    this.handles.push(handle);
    return handle;
  }

  async waitForStarts(count: number) {
    for (let attempt = 0; attempt < 20 && this.starts.length < count; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(this.starts).toHaveLength(count);
  }
}

class StreamingFrames implements ContinuousAudioBackend {
  readonly queue = new Queue<PcmFrame | null>();
  closed = false;

  push(value: number, timestamp: number) {
    const pcm = Buffer.alloc(40);
    for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(value, offset);
    this.queue.push({ pcm, timestamp });
  }

  async *frames(signal: AbortSignal): AsyncIterable<PcmFrame> {
    while (!signal.aborted) {
      const frame = await this.queue.take();
      if (!frame) return;
      yield frame;
    }
  }

  async close() {
    this.closed = true;
    this.queue.push(null);
  }
}

class StreamingRecognizer implements UtteranceRecognizer {
  readonly calls: Buffer[] = [];
  closed = false;

  constructor(private readonly answers: string[]) {}

  async recognize(wav: Buffer) {
    this.calls.push(wav);
    return this.answers.shift() || "";
  }

  async close() {
    this.closed = true;
  }
}

function pushUtterance(audio: StreamingFrames, timestamp: number) {
  audio.push(12_000, timestamp);
  audio.push(0, timestamp + 20);
}

class Queue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  async take(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class QueueTranscriptSource implements TranscriptSource {
  readonly queue = new Queue<TranscriptEvent | null>();
  readonly renewActiveWindow = jest.fn();
  readonly deactivate = jest.fn();

  async *events(signal: AbortSignal): AsyncIterable<TranscriptEvent> {
    while (!signal.aborted) {
      const event = await this.queue.take();
      if (!event) return;
      yield event;
    }
  }

  async close() {
    this.queue.push(null);
  }
}

class FakeHandle implements InteractiveAgentHandle {
  readonly taskId = "task-1";
  readonly eventQueue = new Queue<AgentRuntimeEvent>();
  readonly interrupted = deferred<AgentInput>();
  readonly sent = deferred<AgentInput>();
  readonly stopped = deferred<void>();
  private readonly completion = deferred<{ answer: string; costUsd: number }>();
  readonly done = this.completion.promise;

  async send(input: AgentInput) {
    this.sent.resolve(input);
  }

  async interrupt(input: AgentInput) {
    this.interrupted.resolve(input);
  }

  async *events(signal?: AbortSignal): AsyncIterable<AgentRuntimeEvent> {
    while (!signal?.aborted) yield await this.eventQueue.take();
  }

  async stop() {
    this.stopped.resolve();
    this.completion.resolve({ answer: "stopped", costUsd: 0 });
  }

  complete(answer: string) {
    this.completion.resolve({ answer, costUsd: 0 });
  }
}

class FakeRuntime implements VoiceAgentRuntime {
  readonly handle = new FakeHandle();
  readonly started = deferred<AgentInput>();

  async start(options: { initialInput: AgentInput }) {
    this.started.resolve(options.initialInput);
    return this.handle;
  }
}

function final(text: string, id: string): TranscriptEvent {
  return {
    type: "transcript.final",
    utteranceId: id,
    text,
    timestamp: Date.now(),
    activation: "push-to-talk",
  };
}

describe("VoiceSession", () => {
  test("does not speak transport errors or interruption control messages", () => {
    expect(isSpeakableAssistantOutput("User interrupted this AI completion. Please continue."))
      .toBe(false);
    expect(isSpeakableAssistantOutput("400 Your input exceeds the context window of this model."))
      .toBe(false);
    expect(isSpeakableAssistantOutput("ERROR: Processed image is too large")).toBe(false);
    expect(isSpeakableAssistantOutput("I opened the requested application.")).toBe(true);
  });

  test("stops an active task when its configured cost limit is reached", async () => {
    const source = new QueueTranscriptSource();
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const session = new VoiceSession(runtime, source, undefined, {
      services: createTestServices(),
      agent: "Developer",
      maxTaskCostUsd: 0.1,
    });
    const running = session.run(controller.signal);

    source.queue.push(final("inspect the screen", "utterance-budget"));
    await runtime.started.promise;
    runtime.handle.eventQueue.push({ type: "cost.updated", costUsd: 0.11 });
    await runtime.handle.stopped.promise;

    controller.abort();
    await session.stop();
    await running;
  });

  test("returns to wake gating after the post-task idle window", async () => {
    const source = new QueueTranscriptSource();
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const events: VoiceSessionEvent[] = [];
    const { services, clock } = createTestHarness();
    const session = new VoiceSession(runtime, source, undefined, {
      services,
      agent: "Developer",
      conversationIdleMs: 5,
      onEvent: (event) => events.push(event),
    });
    const running = session.run(controller.signal);

    source.queue.push(final("do this task", "utterance-idle"));
    await runtime.started.promise;
    runtime.handle.complete("done");
    // let the completion be processed, then let the idle window elapse on the fake clock
    for (let i = 0; i < 20 && !source.renewActiveWindow.mock.calls.length; i++) await new Promise<void>((r) => setImmediate(r));
    clock.advance(15);

    expect(source.renewActiveWindow).toHaveBeenCalled();
    expect(source.deactivate).toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "wake.deactivated", reason: "inactivity" }));
    controller.abort();
    await session.stop();
    await running;
  });

  test("ignores recognized loudspeaker echo instead of interrupting itself", async () => {
    const source = new QueueTranscriptSource();
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const stopPlayback = jest.fn(async () => ({
      text: "Why did the scarecrow win an award? Because he was outstanding in his field!",
      completed: false,
      elapsedMs: 100,
    }));
    const played = deferred<void>();
    const speech: SpeechOutput = {
      play: async () => {
        played.resolve();
        return { stop: stopPlayback, done: new Promise(() => undefined) };
      },
    };
    const session = new VoiceSession(runtime, source, speech, {
      services: createTestServices(),
      agent: "Developer",
      sessionId: "session-echo",
    });
    const running = session.run(controller.signal);

    source.queue.push(final("tell me a joke", "utterance-1"));
    await runtime.started.promise;
    runtime.handle.eventQueue.push({
      type: "output.completed",
      generationId: "generation-echo",
      text: "Why did the scarecrow win an award? Because he was outstanding in his field!",
    });
    await played.promise;
    source.queue.push({
      type: "speech.started",
      utteranceId: "utterance-echo",
      timestamp: Date.now(),
    });
    source.queue.push(final("Why did the scarecrow win an award", "utterance-echo"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopPlayback).not.toHaveBeenCalled();
    controller.abort();
    await session.stop();
    await running;
  });

  test("queues speech as additional context while the agent is silently working", async () => {
    const source = new QueueTranscriptSource();
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const events: VoiceSessionEvent[] = [];
    const session = new VoiceSession(runtime, source, undefined, {
      services: createTestServices(),
      agent: "Developer",
      sessionId: "session-1",
      onEvent: (event) => events.push(event),
    });
    const running = session.run(controller.signal);

    source.queue.push(final("open the browser", "utterance-1"));
    await expect(runtime.started.promise).resolves.toMatchObject({
      id: "utterance-1",
      content: "open the browser",
    });

    source.queue.push(final("actually use the current tab", "utterance-2"));
    await expect(runtime.handle.sent.promise).resolves.toMatchObject({
      id: "utterance-2",
      content: "actually use the current tab",
      interrupt: false,
      metadata: expect.objectContaining({ delivery: "additional-context" }),
    });

    controller.abort();
    await session.stop();
    await running;
    expect(events.some((event) => event.type === "transcript" && event.final)).toBe(true);
  });

  test("preserves bounded conversation context after a task-scoped handle completes", async () => {
    const source = new QueueTranscriptSource();
    const runtime = new SequentialRuntime();
    const controller = new AbortController();
    const session = new VoiceSession(runtime, source, undefined, {
      services: createTestServices(),
      agent: "Developer",
      sessionId: "session-context",
    });
    const running = session.run(controller.signal);

    source.queue.push(final("open mail", "utterance-1"));
    await runtime.waitForStarts(1);
    expect(runtime.starts[0].content).toBe("open mail");
    runtime.handles[0].complete("Mail is open.");
    await runtime.handles[0].done;
    await new Promise<void>((resolve) => setImmediate(resolve));

    source.queue.push(final("show the newest message", "utterance-2"));
    await runtime.waitForStarts(2);
    expect(runtime.starts[1].content).toEqual(expect.stringContaining("User: open mail"));
    expect(runtime.starts[1].content).toEqual(expect.stringContaining("Assistant: Mail is open."));
    expect(runtime.starts[1].content).toEqual(
      expect.stringContaining("User: show the newest message")
    );

    controller.abort();
    await session.stop();
    await running;
  });

  test("end-to-end streaming wake gating, no-enter turns, and barge-in routing", async () => {
    const audio = new StreamingFrames();
    const recognizer = new StreamingRecognizer([
      "background speech",
      "hey knowhow start the task",
      "change direction",
    ]);
    const source = new ContinuousTranscriptSource(
      audio,
      recognizer,
      {
        sampleRate: 1_000,
        channels: 1,
        speechThreshold: 0.05,
        minSpeechMs: 20,
        silenceMs: 20,
        preRollMs: 0,
        wakePhrase: "hey knowhow",
        activeWindowMs: 1_000,
      },
      { now: () => 100 }
    );
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const playbackStopped = deferred<void>();
    let speechClosed = false;
    const speech: SpeechOutput = {
      play: async (text) => ({
        done: new Promise(() => undefined),
        stop: async () => {
          playbackStopped.resolve();
          return { text, completed: false, elapsedMs: 10 };
        },
      }),
      close: async () => {
        speechClosed = true;
      },
    };
    const session = new VoiceSession(runtime, source, speech, {
      services: createTestServices(),
      agent: "Developer",
      sessionId: "session-e2e",
    });
    const running = session.run(controller.signal);

    // Inactive noise is recognized for wake detection but never reaches the agent.
    pushUtterance(audio, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recognizer.calls).toHaveLength(1);

    // A wake turn starts the agent without any terminal input/Enter key.
    pushUtterance(audio, 100);
    await expect(runtime.started.promise).resolves.toMatchObject({
      content: "start the task",
    });

    runtime.handle.eventQueue.push({
      type: "output.completed",
      generationId: "speaking-generation",
      text: "long response",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The completed follow-up is checked against spoken output, then genuine
    // barge-in stops TTS and is routed as an interrupt to the active task.
    pushUtterance(audio, 200);
    await playbackStopped.promise;
    await expect(runtime.handle.interrupted.promise).resolves.toMatchObject({
      content: "change direction",
      interrupt: true,
    });

    controller.abort();
    await session.stop();
    await running;
    expect(recognizer.calls).toHaveLength(3);
    expect(audio.closed).toBe(true);
    expect(recognizer.closed).toBe(true);
    expect(speechClosed).toBe(true);
  });

  test("barge-in stops playback before sending interruption context", async () => {
    const source = new QueueTranscriptSource();
    const runtime = new FakeRuntime();
    const controller = new AbortController();
    const stopped = deferred<void>();
    const playback: PlaybackHandle = {
      stop: async () => {
        stopped.resolve();
        return { text: "a long answer", completed: false, elapsedMs: 25 };
      },
      done: new Promise(() => undefined),
    };
    const played = deferred<void>();
    const speech: SpeechOutput = {
      play: async () => {
        played.resolve();
        return playback;
      },
    };
    const session = new VoiceSession(runtime, source, speech, {
      services: createTestServices(),
      agent: "Developer",
      sessionId: "session-2",
    });
    const running = session.run(controller.signal);

    source.queue.push(final("explain this", "utterance-1"));
    await runtime.started.promise;
    runtime.handle.eventQueue.push({
      type: "output.completed",
      generationId: "generation-1",
      text: "a long answer",
    });
    await played.promise;
    source.queue.push({
      type: "speech.started",
      utteranceId: "utterance-2",
      timestamp: Date.now(),
    });
    source.queue.push(final("please change direction", "utterance-2"));

    await stopped.promise;
    await expect(runtime.handle.sent.promise).resolves.toMatchObject({
      kind: "observation",
      interrupt: false,
      metadata: { generationId: "generation-1" },
    });

    controller.abort();
    await session.stop();
    await running;
  });
});
