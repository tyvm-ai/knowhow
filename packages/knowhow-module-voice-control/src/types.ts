import type {
  AgentInput,
  AgentRuntimeEvent,
  InteractiveAgentHandle,
} from "@tyvm/knowhow/sdk";
import type { VoiceCommandEvent } from "./voiceHub";

export type { VoiceMode } from "./commandMode";
export type CommandSource = "builtin" | "dynamic" | "module" | "config";

export const VOICE_EVENT_VERSION = 1 as const;

export type ActivationKind = "push-to-talk" | "wake-word" | "text" | "programmatic";

/**
 * Per-utterance latency timestamps (epoch ms) recorded by
 * ContinuousTranscriptSource and extended by VoiceSession.
 */
export interface UtteranceTiming {
  /** VAD speech onset (first voiced frame). */
  spokenAt: number;
  /** End of the last voiced frame. */
  speechEndAt: number;
  /** Endpoint fired (trailing silence reached / max length). */
  finalizedAt: number;
  /** Recognizer started (after any queued recognitions). */
  sttStartAt: number;
  /** Recognizer finished. */
  sttEndAt: number;
  /** Duration of audio sent to the recognizer (ms). */
  audioMs: number;
  /** Voiced audio within the utterance (ms). */
  voicedMs: number;
  /** Effective trailing-silence threshold used for this utterance (ms). */
  silenceMs: number;
  /** Gate mode at finalize time. */
  mode: "command" | "agent";
  /** Recognizer backend label, e.g. "whisper-server" or "whisper-cli". */
  sttBackend?: string;
  /** Gaze lookup duration in VoiceSession (ms), if one was performed. */
  gazeMs?: number;
  /** Command dispatched (posted to hub / handler invoked). */
  dispatchedAt?: number;
  /** Set by the hub when it receives the command. */
  hubReceivedAt?: number;
}

export type TranscriptEvent =
  | { type: "speech.started"; utteranceId: string; timestamp: number }
  | { type: "wake.activated"; utteranceId: string; timestamp: number; phrase: string }
  | { type: "wake.deactivated"; utteranceId: string; timestamp: number; reason: "voice-command" | "inactivity" }
  | { type: "transcript.partial"; utteranceId: string; text: string; timestamp: number }
  | {
      type: "transcript.final";
      utteranceId: string;
      text: string;
      timestamp: number;
      activation: ActivationKind;
      /** Present when the wake phrase was detected in this utterance. */
      wakeMatched?: boolean;
      /** epoch ms of VAD speech onset (for gaze lookup). */
      spokenAt?: number;
      /** Latency breakdown for this utterance (continuous capture only). */
      timing?: UtteranceTiming;
    }
  | { type: "mode.changed"; mode: "command" | "agent"; timestamp: number }
  | { type: "command.matched"; utteranceId: string; phrase: string; source: CommandSource; timestamp: number }
  | { type: "command.unmatched"; utteranceId: string; text: string; timestamp: number };

export interface TranscriptSource {
  events(signal: AbortSignal): AsyncIterable<TranscriptEvent>;
  /** Extend or end wake-free conversation mode from the session lifecycle. */
  renewActiveWindow?(): void;
  deactivate?(): void;
  /** Switch gate behaviour: command mode accepts single words without wake phrase; agent mode requires wake. */
  setGateMode?(mode: "command" | "agent"): void;
  /** Update the VAD trailing-silence threshold (ms) used for endpointing. */
  setCommandSilenceMs?(ms: number): void;
  /** Update the STT prompt with the current active command phrases. */
  setPromptPhrases?(phrases: string[]): void;
  close?(): Promise<void>;
}

export interface PlaybackProgress {
  text: string;
  completed: boolean;
  elapsedMs: number;
}

export interface PlaybackHandle {
  stop(reason?: string): Promise<PlaybackProgress>;
  readonly done: Promise<PlaybackProgress>;
}

export interface SpeechOutput {
  play(text: string, options: { generationId: string; signal: AbortSignal }): Promise<PlaybackHandle>;
  close?(): Promise<void>;
}

export interface VoiceAgentRuntime {
  start(options: {
    agent: string;
    initialInput: AgentInput;
    signal?: AbortSignal;
  }): Promise<InteractiveAgentHandle>;
}

export type VoiceSessionState = "idle" | "listening" | "thinking" | "speaking" | "stopping" | "stopped";

export type VoiceSessionEvent =
  | { version: 1; type: "session.state"; sessionId: string; timestamp: number; state: VoiceSessionState }
  | { version: 1; type: "transcript"; sessionId: string; timestamp: number; final: boolean; utteranceId: string; text: string }
  | { version: 1; type: "wake.activated"; sessionId: string; timestamp: number; utteranceId: string; phrase: string }
  | { version: 1; type: "wake.deactivated"; sessionId: string; timestamp: number; utteranceId: string; reason: "voice-command" | "inactivity" }
  | { version: 1; type: "echo.suppressed"; sessionId: string; timestamp: number; utteranceId: string; text: string }
  | { version: 1; type: "playback.interrupted"; sessionId: string; timestamp: number; generationId: string; progress: PlaybackProgress }
  | { version: 1; type: "agent"; sessionId: string; timestamp: number; event: AgentRuntimeEvent }
  | { version: 1; type: "session.error"; sessionId: string; timestamp: number; message: string }
  | { version: 1; type: "mode.changed"; sessionId: string; timestamp: number; mode: "command" | "agent" }
  | { version: 1; type: "command.matched"; sessionId: string; timestamp: number; utteranceId: string; phrase: string; source: CommandSource }
  | { version: 1; type: "command.unmatched"; sessionId: string; timestamp: number; utteranceId: string; text: string }
  | { version: 1; type: "command.dispatched"; sessionId: string; timestamp: number; event: VoiceCommandEvent }
  | { version: 1; type: "command.latency"; sessionId: string; timestamp: number; utteranceId: string; phrase: string; source: CommandSource; timing: UtteranceTiming };

export type VoiceSessionEventPayload = VoiceSessionEvent extends infer Event
  ? Event extends VoiceSessionEvent ? Omit<Event, "version" | "sessionId" | "timestamp"> : never
  : never;

export interface VoiceSessionOptions {
  agent: string;
  sessionId?: string;
  /** Return to wake-word gating this long after a completed task. */
  conversationIdleMs?: number;
  maxTaskCostUsd?: number;
  /** Silence duration (ms) for endpointing in command mode (default 350). */
  commandSilenceMs?: number;
  /** Initial mode: "command" (default) or "agent". */
  initialMode?: "command" | "agent";
  /** Registered voice commands (built-ins + modules + knowhow.json). Default: built-ins. */
  commands?: import("./voiceCommands").RegisteredVoiceCommand[];
  /** Append per-command latency JSON lines here (disabled when unset). */
  latencyLogFile?: string;
  /** Diagnostic log sink for command handlers. */
  log?: (message: string) => void;
  onEvent?: (event: VoiceSessionEvent) => void;
  /** Services container for this session (platform, gaze, pointer, pending, clock, logger…). Default: production services. */
  services?: import("./services").VoiceServices;
  /** Packs whose lifecycle hooks this session runs. Default: every shipped pack. */
  packs?: readonly import("./packs/define").AnyVoicePack[];
  /** Intent-recovery engine (misheard commands). Default: one built from the recoverers of `packs`. */
  recovery?: import("./recovery/engine").RecoveryEngine;
  /** Injected mouse mover — avoids a direct require of computer-use in VoiceSession. */
  mouse?: {
    moveMouse(x: number, y: number): Promise<void>;
    clickAt(x: number, y: number, button?: "left" | "right"): Promise<void>;
    doubleClickAt(x: number, y: number): Promise<void>;
    /** Click wherever the pointer currently is, without moving it. */
    clickHere?(button?: "left" | "right"): Promise<void>;
  };
}
