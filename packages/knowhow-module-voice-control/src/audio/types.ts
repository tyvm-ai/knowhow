import { commandExists } from "./preflight";

export interface PcmFrame {
  pcm: Buffer;
  /** Monotonic capture time, in milliseconds. */
  timestamp: number;
}

export interface ContinuousAudioBackend {
  frames(signal: AbortSignal): AsyncIterable<PcmFrame>;
  close?(): Promise<void>;
}

export interface UtteranceRecognizer {
  recognize(wav: Buffer, signal: AbortSignal): Promise<string>;
  /** Backend label for latency logs (e.g. "whisper-server", "whisper-cli"). */
  readonly label?: string;
  /** Update the STT prompt with active command phrases (optional). */
  setPromptPhrases?(phrases: string[]): void;
  close?(): Promise<void>;
}

export interface ContinuousClock {
  now(): number;
}

export interface ContinuousTranscriptOptions {
  sampleRate?: number;
  channels?: number;
  /** RMS in the range 0..1 which is considered speech. */
  speechThreshold?: number;
  /** Speech required before opening an utterance. */
  minSpeechMs?: number;
  /** Silence required to close an utterance. */
  silenceMs?: number;
  /** Audio retained before the first speech frame. */
  preRollMs?: number;
  maxUtteranceMs?: number;
  wakePhrase?: string;
  /** Time after a wake phrase/final turn during which follow-ups need no wake phrase. */
  activeWindowMs?: number;
  /** Minimum recognized words required to dispatch a task (wake/sleep commands are exempt). */
  minCommandWords?: number;
  /**
   * Command-mode utterances longer than this (ms of audio) are almost certainly
   * ambient noise (keyboard, fan) holding the VAD open; they're logged. Default 2500.
   */
  maxCommandUtteranceMs?: number;
  /** Interval for the ambient noise-floor debug log (ms). Default 10000; 0 disables. */
  noiseFloorIntervalMs?: number;
}

export type ContinuousLogLevel = "debug" | "info" | "warn";

export type ContinuousLogger = (level: ContinuousLogLevel, message: string) => void;

export type ContinuousDiagnosticCode =
  | "platform.unsupported"
  | "capture.available"
  | "capture.missing"
  | "recognizer.configured"
  | "recognizer.remote"
  | "recognizer.missing"
  | "microphone.permission";

export interface ContinuousDiagnostic {
  code: ContinuousDiagnosticCode;
  level: "info" | "warning" | "error";
  message: string;
  remedy?: string;
}

export interface ContinuousPreflightOptions {
  platform?: NodeJS.Platform;
  captureCommand?: string;
  recognizerCommand?: string;
  commandExists?: (command: string) => Promise<boolean>;
  remoteRecognizer?: boolean;
  wakePhrase?: string;
}
