import { randomUUID } from "crypto";
import { spawn, ChildProcess } from "child_process";
import { createInterface, Interface } from "readline/promises";
import { stdin, stdout } from "process";
import { voiceToText } from "@tyvm/knowhow/ts_build/src/microphone";
import {
  PlaybackHandle,
  PlaybackProgress,
  SpeechOutput,
  TranscriptEvent,
  TranscriptSource,
} from "./types";
import type { UtteranceRecognizer } from "./continuous";

export interface AudioTranscriptionClient {
  createAudioTranscription(
    provider: string,
    options: {
      file: Buffer;
      fileName: string;
      model: string;
      prompt?: string;
      signal?: AbortSignal;
    }
  ): Promise<{ text: string }>;
}

/** Remote final-utterance STT through Knowhow's configured OpenAI client. */
export class OpenAIUtteranceRecognizer implements UtteranceRecognizer {
  private dynamicPrompt?: string;

  constructor(
    private readonly client: AudioTranscriptionClient,
    private readonly model = "whisper-1",
    private readonly prompt?: string
  ) {}

  setPromptPhrases(phrases: string[]): void {
    this.dynamicPrompt = phrases.length > 0 ? phrases.slice(0, 30).join(". ") + "." : undefined;
  }

  async recognize(wav: Buffer, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return "";
    try {
      const response = await this.client.createAudioTranscription("openai", {
        file: wav,
        fileName: `knowhow-voice-${randomUUID()}.wav`,
        model: this.model,
        prompt: [this.prompt, this.dynamicPrompt].filter(Boolean).join(" ") || undefined,
        signal,
      });
      return signal.aborted ? "" : response.text.trim();
    } catch (error) {
      if (signal.aborted) return "";
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `OpenAI speech transcription failed: ${message}. Configure an OpenAI client/API key, ` +
          `or use --local-stt-command with a local whisper.cpp model.`
      );
    }
  }
}

export class OneShotTranscriptSource implements TranscriptSource {
  constructor(private readonly text: string) {}

  async *events(): AsyncIterable<TranscriptEvent> {
    const utteranceId = randomUUID();
    yield {
      type: "transcript.final",
      utteranceId,
      text: this.text,
      timestamp: Date.now(),
      activation: "programmatic",
    };
  }
}

export class TextTranscriptSource implements TranscriptSource {
  private readline?: Interface;

  async *events(signal: AbortSignal): AsyncIterable<TranscriptEvent> {
    this.readline = createInterface({ input: stdin, output: stdout });
    signal.addEventListener("abort", () => this.readline?.close(), { once: true });

    while (!signal.aborted) {
      let text: string;
      try {
        text = await this.readline.question("you> ");
      } catch (_) {
        return;
      }
      if (["/stop", "/exit", "/quit"].includes(text.trim().toLowerCase())) return;
      yield {
        type: "transcript.final",
        utteranceId: randomUUID(),
        text,
        timestamp: Date.now(),
        activation: "text",
      };
    }
  }

  async close(): Promise<void> {
    this.readline?.close();
  }
}

/** Push-to-talk adapter backed by Knowhow's existing SoX + transcription path. */
export class PushToTalkTranscriptSource implements TranscriptSource {
  private closed = false;

  async *events(signal: AbortSignal): AsyncIterable<TranscriptEvent> {
    while (!signal.aborted && !this.closed) {
      const utteranceId = randomUUID();
      // PTT activation is explicit, so stopping playback before opening the
      // recorder is desirable even though this adapter has no local VAD yet.
      yield { type: "speech.started", utteranceId, timestamp: Date.now() };
      const text = await voiceToText();
      if (["/stop", "/exit", "/quit"].includes(text.trim().toLowerCase())) return;
      yield {
        type: "transcript.final",
        utteranceId,
        text,
        timestamp: Date.now(),
        activation: "push-to-talk",
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ProcessPlayback implements PlaybackHandle {
  readonly done: Promise<PlaybackProgress>;
  private completed = false;
  private settled = false;
  private stopping = false;
  private readonly startedAt = Date.now();
  private resolveDone!: (progress: PlaybackProgress) => void;
  private rejectDone!: (error: Error) => void;

  constructor(private readonly process: ChildProcess, private readonly text: string) {
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    process.once("exit", (code) => {
      if (code === 0 || this.stopping) this.finish(code === 0);
      else this.fail(new Error(`System speech process exited with code ${code}`));
    });
    process.once("error", (error) =>
      this.fail(new Error(`Unable to start system speech: ${error.message}`))
    );
  }

  async stop(): Promise<PlaybackProgress> {
    this.stopping = true;
    if (!this.settled) this.process.kill("SIGTERM");
    return this.finish(false);
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectDone(error);
  }

  private finish(completed: boolean): PlaybackProgress {
    const progress = {
      text: this.text,
      completed: this.completed || completed,
      elapsedMs: Date.now() - this.startedAt,
    };
    this.completed = progress.completed;
    if (!this.settled) {
      this.settled = true;
      this.resolveDone(progress);
    }
    return progress;
  }
}

/** Uses the platform `say` command on macOS and `espeak` elsewhere. */
export class SystemSpeechOutput implements SpeechOutput {
  private active = new Set<ProcessPlayback>();

  async play(text: string, options: { signal: AbortSignal }): Promise<PlaybackHandle> {
    const command = process.platform === "darwin" ? "say" : "espeak";
    const child = spawn(command, [text], { stdio: "ignore" });
    const playback = new ProcessPlayback(child, text);
    this.active.add(playback);
    const onAbort = () => void playback.stop();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      options.signal.removeEventListener("abort", onAbort);
      this.active.delete(playback);
    };
    void playback.done.then(cleanup, cleanup);
    if (options.signal.aborted) onAbort();
    return playback;
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.active, (playback) => playback.stop()));
    this.active.clear();
  }
}
