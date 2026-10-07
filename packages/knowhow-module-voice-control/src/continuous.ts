import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { TranscriptEvent, TranscriptSource, UtteranceTiming } from "./types";

/** A chunk of interleaved signed 16-bit little-endian PCM. */
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

/** Summarise per-frame RMS values for the ambient noise-floor log. */
export function summariseNoiseFloor(
  rmsValues: readonly number[],
  threshold: number,
): { p10: number; median: number; p90: number; aboveThresholdPct: number } | undefined {
  if (!rmsValues.length) return undefined;
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const above = rmsValues.filter((v) => v >= threshold).length;
  return {
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
    aboveThresholdPct: Math.round((above / rmsValues.length) * 1000) / 10,
  };
}

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

const systemClock: ContinuousClock = { now: () => Date.now() };

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failed = false;
  private failure?: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failed = true;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failed) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function abortError(): Error {
  const error = new Error("Continuous transcript capture was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function frameDurationMs(frame: Buffer, sampleRate: number, channels: number): number {
  return (frame.length / (2 * channels * sampleRate)) * 1000;
}

export function pcmRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let squareSum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset) / 32768;
    squareSum += value * value;
  }
  return Math.sqrt(squareSum / samples);
}

/** Wrap PCM as a standard 16-bit WAV for final-utterance recognizers. */
export function pcmToWav(pcm: Buffer, sampleRate = 16_000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Looser filter for command mode — rejects Whisper hallucinations but allows
 * single-word voice commands like "click", "slice", "zoom", etc.
 * In agent mode use the stricter isMeaningfulTranscript instead.
 */
export function isMeaningfulCommandTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/[a-z0-9]/.test(normalized)) return false;
  const marker = normalized.replace(/[^a-z0-9']+/g, " ").trim();
  // Reject empty/noise/silence placeholders.
  if (/^(?:blank audio|blank|no speech|nospeech|no speech detected|inaudible|silence|static|noise|background noise|music|applause|laughter|laughing|cough(?:ing)?|breathing|beep(?:ing)?)$/.test(marker)) return false;
  // Reject pure filler/acknowledgement hallucinations — NOT mechanical sounds
  // (those could be command words in a different context).
  if (/^(?:you|yeah|yes|no|thank you|thanks|you're welcome|okay|ok)$/.test(marker)) return false;
  return true;
}

/** Reject recognizer placeholders and sounds that are not a user command. */
export function isMeaningfulTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/[a-z0-9]/.test(normalized)) return false;
  const marker = normalized.replace(/[^a-z0-9']+/g, " ").trim();
  if (/^(?:blank audio|blank|no speech|nospeech|no speech detected|inaudible|silence|static|noise|background noise|music|applause|laughter|laughing|cough(?:ing)?|breathing|beep(?:ing)?)$/.test(marker)) return false;
  if (/^(?:keyboard(?: clicking| noise)?|typing(?: noise)?|click(?:ing)?|mouse clicking)$/.test(marker)) return false;
  if (/^(?:you|yeah|yes|no|thank you|thanks|you're welcome|okay|ok)$/.test(marker)) return false;
  return true;
}

/** Remove Whisper control/caption markers without rewriting the user's words. */
export function stripRecognizerArtifacts(text: string): string {
  return text
    .replace(
      /[\[(](?:blank[ _-]?audio|no[ _-]?speech|inaudible|silence|static|noise|background[ _-]?noise|music|applause|laughter|laughing|cough(?:ing)?|breathing|beep(?:ing)?|keyboard(?: clicking| noise)?|typing(?: noise)?|mouse clicking)(?:\]|\))/gi,
      " "
    )
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Host-owned VAD and wake gating around any continuous PCM source and local
 * final-utterance recognizer. It deliberately never emits noise, partial
 * recognition, or a wake-only utterance into agent context.
 */
export class ContinuousTranscriptSource implements TranscriptSource {
  private readonly options: Required<ContinuousTranscriptOptions>;
  private log: ContinuousLogger = () => undefined;
  private readonly ownAbort = new AbortController();
  private closed = false;
  private activeUntil = Number.NEGATIVE_INFINITY;
  private gateMode: "command" | "agent" = "agent";
  private commandSilenceMs: number;

  constructor(
    private readonly audio: ContinuousAudioBackend,
    private readonly recognizer: UtteranceRecognizer,
    options: ContinuousTranscriptOptions = {},
    private readonly clock: ContinuousClock = systemClock,
    logger?: ContinuousLogger
  ) {
    if (logger) this.log = logger;
    this.options = {
      sampleRate: options.sampleRate ?? 16_000,
      channels: options.channels ?? 1,
      speechThreshold: options.speechThreshold ?? 0.012,
      minSpeechMs: options.minSpeechMs ?? 80,
      silenceMs: options.silenceMs ?? 1_000,
      preRollMs: options.preRollMs ?? 120,
      maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
      wakePhrase: options.wakePhrase?.trim() ?? "",
      activeWindowMs: options.activeWindowMs ?? 30_000,
      minCommandWords: options.minCommandWords ?? 2,
      maxCommandUtteranceMs: options.maxCommandUtteranceMs ?? 2_500,
      noiseFloorIntervalMs: options.noiseFloorIntervalMs ?? 10_000,
    };
    if (this.options.sampleRate <= 0 || this.options.channels <= 0) {
      throw new Error("sampleRate and channels must be positive");
    }
    this.commandSilenceMs = this.options.silenceMs;
    if (this.options.speechThreshold < 0 || this.options.speechThreshold > 1) {
      throw new Error("speechThreshold must be in the range 0..1");
    }
    if (
      this.options.silenceMs < 0 ||
      this.options.minSpeechMs < 0 ||
      this.options.preRollMs < 0 ||
      this.options.maxUtteranceMs < 0 ||
      this.options.activeWindowMs < 0 ||
      this.options.minCommandWords < 0
    ) {
      throw new Error("VAD durations cannot be negative");
    }
  }

  renewActiveWindow(): void {
    this.activeUntil = this.clock.now() + this.options.activeWindowMs;
  }

  deactivate(): void {
    this.activeUntil = Number.NEGATIVE_INFINITY;
  }

  setGateMode(mode: "command" | "agent"): void {
    this.gateMode = mode;
  }

  setCommandSilenceMs(ms: number): void {
    this.commandSilenceMs = ms;
  }

  setLogger(logger: ContinuousLogger): void {
    this.log = logger;
  }

  /** Trailing-silence threshold the NEXT utterance will use in the current mode. */
  effectiveSilenceMs(): number {
    return this.gateMode === "command" ? this.commandSilenceMs : this.options.silenceMs;
  }

  setPromptPhrases(phrases: string[]): void {
    this.recognizer.setPromptPhrases?.(phrases);
  }

  async *events(signal: AbortSignal): AsyncIterable<TranscriptEvent> {
    if (this.closed) return;
    const captureAbort = new AbortController();
    const abort = () => captureAbort.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.ownAbort.signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || this.ownAbort.signal.aborted) captureAbort.abort();

    const eventQueue = new AsyncEventQueue<TranscriptEvent>();
    let recognitionChain = Promise.resolve();
    let preRoll: Array<{ frame: PcmFrame; duration: number }> = [];
    let preRollDuration = 0;
    let utterance: Buffer[] | undefined;
    let utteranceId = "";
    let utteranceStartedAt = 0;
    let voicedMs = 0;
    let trailingSilenceMs = 0;
    let onsetEmitted = false;
    let activeAtOnset = false;
    let speechEndAt = 0;
    let noiseRms: number[] = [];
    let noiseWindowStart = Number.NaN;
    let effectiveSilenceMs = this.gateMode === "command" ? this.commandSilenceMs : this.options.silenceMs;

    const reset = () => {
      utterance = undefined;
      utteranceId = "";
      utteranceStartedAt = 0;
      voicedMs = 0;
      trailingSilenceMs = 0;
      onsetEmitted = false;
      activeAtOnset = false;
      speechEndAt = 0;
      preRoll = [];
      preRollDuration = 0;
      // Refresh effective silence threshold after each utterance (mode/commandSilenceMs may change between utterances).
      effectiveSilenceMs = this.gateMode === "command" ? this.commandSilenceMs : this.options.silenceMs;
    };

    const finalize = (): void => {
      if (!utterance || voicedMs < this.options.minSpeechMs) {
        reset();
        return;
      }
      const id = utteranceId;
      const startedAt = utteranceStartedAt;
      const endedSpeechAt = speechEndAt || startedAt;
      const utteranceVoicedMs = voicedMs;
      const silenceUsed = effectiveSilenceMs;
      const modeAtFinalize = this.gateMode;
      const hadOnset = onsetEmitted;
      const wasActive = activeAtOnset;
      const capturedAudio = Buffer.concat(utterance);
      // Keep a small natural tail, but do not send the full endpointing silence
      // to Whisper. Besides reducing work, this avoids common trailing-silence
      // hallucinations such as "Thank you".
      const trimMs = Math.max(0, trailingSilenceMs - 120);
      const trimBytes = Math.floor(
        (trimMs * this.options.sampleRate * this.options.channels * 2) / 1_000
      );
      const audio = capturedAudio.subarray(0, Math.max(0, capturedAudio.length - trimBytes));
      const finalizedAt = this.clock.now();
      const audioMs = Math.round(
        (audio.length / (2 * this.options.channels * this.options.sampleRate)) * 1000
      );
      if (modeAtFinalize === "command" && audioMs > this.options.maxCommandUtteranceMs) {
        this.log(
          "info",
          `long command-mode utterance (${audioMs}ms audio, ${Math.round(utteranceVoicedMs)}ms voiced) — likely ambient noise holding the VAD open; ` +
            `later commands queue behind its recognition. Consider raising --speech-threshold.`
        );
      }
      reset();
      recognitionChain = recognitionChain
        .then(async () => {
        throwIfAborted(captureAbort.signal);
        const sttStartAt = this.clock.now();
        const raw = (await this.recognizer.recognize(
          pcmToWav(audio, this.options.sampleRate, this.options.channels),
          captureAbort.signal
        )).trim();
        const sttEndAt = this.clock.now();
        throwIfAborted(captureAbort.signal);
        if (!raw) return;
        const timing: UtteranceTiming = {
          spokenAt: startedAt,
          speechEndAt: endedSpeechAt,
          finalizedAt,
          sttStartAt,
          sttEndAt,
          audioMs,
          voicedMs: Math.round(utteranceVoicedMs),
          silenceMs: silenceUsed,
          mode: modeAtFinalize,
          ...(this.recognizer.label ? { sttBackend: this.recognizer.label } : {}),
        };

        const detected: TranscriptEvent = {
          type: "transcript.partial",
          utteranceId: id,
          text: raw,
          timestamp: this.clock.now(),
        };
        eventQueue.push(detected);
        const cleaned = stripRecognizerArtifacts(raw);
        if (!cleaned) return;
        const wake = this.extractWakePhrase(cleaned);
        const now = finalizedAt;

        // ── Command-mode gate ─────────────────────────────────────────────────
        // In command mode: accept all meaningful utterances without requiring a
        // wake phrase; single-word commands are fine. Still filter Whisper
        // hallucinations (but NOT command words like "click"). Always report
        // wakeMatched so the router can switch to agent mode. Sleep commands honoured.
        if (this.gateMode === "command") {
          if (!isMeaningfulCommandTranscript(cleaned)) return;
          const commandText = wake.matched ? wake.remainder : cleaned;
          if (this.isSleepCommand(commandText)) {
            this.deactivate();
            eventQueue.push({ type: "wake.deactivated", utteranceId: id, timestamp: now, reason: "voice-command" });
            return;
          }
          if (!hadOnset) {
            eventQueue.push({ type: "speech.started", utteranceId: id, timestamp: startedAt });
          }
          eventQueue.push({
            type: "transcript.final",
            utteranceId: id,
            text: commandText || cleaned,
            timestamp: now,
            activation: "programmatic",
            wakeMatched: wake.matched,
            spokenAt: startedAt,
            timing,
          });
          if (wake.matched) this.renewActiveWindow();
          return;
        }

        // ── Agent-mode gate (original behaviour) ──────────────────────────────
        // Recognition may lag behind capture. A turn captured while an earlier
        // wake utterance was being recognized still belongs to that active window.
        const activeForTurn = wasActive || finalizedAt <= this.activeUntil;
        const accepted = !this.options.wakePhrase || activeForTurn || wake.matched;
        if (!accepted) return;
        const text = wake.matched ? wake.remainder : cleaned;
        if ((activeForTurn || wake.matched) && this.isSleepCommand(text)) {
          this.deactivate();
          eventQueue.push({
            type: "wake.deactivated",
            utteranceId: id,
            timestamp: now,
            reason: "voice-command",
          });
          return;
        }
        if (!text) {
          this.renewActiveWindow();
          eventQueue.push({
            type: "wake.activated",
            utteranceId: id,
            timestamp: now,
            phrase: this.options.wakePhrase,
          });
          return;
        }
        if (!isMeaningfulTranscript(text)) return;
        const words = text.match(/[a-z0-9]+(?:'[a-z0-9]+)?/gi) ?? [];
        if (words.length < this.options.minCommandWords) return;
        this.renewActiveWindow();
        if (!hadOnset) {
          eventQueue.push({ type: "speech.started", utteranceId: id, timestamp: startedAt });
        }
        eventQueue.push({
          type: "transcript.final",
          utteranceId: id,
          text,
          timestamp: now,
          activation: this.options.wakePhrase ? "wake-word" : "programmatic",
          wakeMatched: wake.matched,
          spokenAt: startedAt,
          timing,
        });
      });
    };

    const producer = (async () => {
      try {
        for await (const frame of this.audio.frames(captureAbort.signal)) {
          if (captureAbort.signal.aborted) break;
          const duration = frameDurationMs(
            frame.pcm,
            this.options.sampleRate,
            this.options.channels
          );
          const rms = pcmRms(frame.pcm);
          const speech = rms >= this.options.speechThreshold;
          if (this.options.noiseFloorIntervalMs > 0) {
            if (Number.isNaN(noiseWindowStart)) noiseWindowStart = frame.timestamp;
            noiseRms.push(rms);
            if (frame.timestamp - noiseWindowStart >= this.options.noiseFloorIntervalMs) {
              const summary = summariseNoiseFloor(noiseRms, this.options.speechThreshold);
              if (summary) {
                this.log(
                  "debug",
                  `ambient RMS p10 ${summary.p10.toFixed(4)} median ${summary.median.toFixed(4)} p90 ${summary.p90.toFixed(4)}; ` +
                    `${summary.aboveThresholdPct}% of frames >= speech threshold ${this.options.speechThreshold}`
                );
              }
              noiseRms = [];
              noiseWindowStart = frame.timestamp;
            }
          }

          if (!utterance) {
            preRoll.push({ frame, duration });
            preRollDuration += duration;
            while (preRollDuration > this.options.preRollMs && preRoll.length > 1) {
              preRollDuration -= preRoll.shift()!.duration;
            }
            if (!speech) continue;
            utteranceId = randomUUID();
            utteranceStartedAt = frame.timestamp;
            activeAtOnset = !this.options.wakePhrase || this.clock.now() <= this.activeUntil;
            utterance = preRoll.map(({ frame: item }) => item.pcm);
            voicedMs = duration;
            speechEndAt = frame.timestamp + duration;
            trailingSilenceMs = 0;
            preRoll = [];
            preRollDuration = 0;
            if (activeAtOnset && voicedMs >= this.options.minSpeechMs) {
              onsetEmitted = true;
              eventQueue.push({ type: "speech.started", utteranceId, timestamp: utteranceStartedAt });
            }
            continue;
          }

          utterance.push(frame.pcm);
          if (speech) {
            voicedMs += duration;
            speechEndAt = frame.timestamp + duration;
            trailingSilenceMs = 0;
            if (activeAtOnset && !onsetEmitted && voicedMs >= this.options.minSpeechMs) {
              onsetEmitted = true;
              eventQueue.push({ type: "speech.started", utteranceId, timestamp: utteranceStartedAt });
            }
          } else {
            trailingSilenceMs += duration;
          }
          const elapsed = frame.timestamp + duration - utteranceStartedAt;
          if (trailingSilenceMs >= effectiveSilenceMs || elapsed >= this.options.maxUtteranceMs) {
            finalize();
          }
          // Give completed recognitions a chance to update wake state without
          // ever waiting for a recognizer that is still running.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!captureAbort.signal.aborted && utterance) finalize();
        if (captureAbort.signal.aborted) {
          eventQueue.end();
          return;
        }
        await recognitionChain;
        eventQueue.end();
      } catch (error) {
        if (captureAbort.signal.aborted) eventQueue.end();
        else eventQueue.fail(error);
      }
    })();

    try {
      while (true) {
        const result = await eventQueue.next();
        if (result.done) break;
        yield result.value;
      }
      await producer;
    } finally {
      captureAbort.abort();
      await producer.catch(() => undefined);
      signal.removeEventListener("abort", abort);
      this.ownAbort.signal.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ownAbort.abort();
    await Promise.all([this.audio.close?.(), this.recognizer.close?.()]);
  }

  /** Host-level sleep commands are handled without spending tokens or entering agent context. */
  private isSleepCommand(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return /^(?:bye(?: bye)?(?: knowhow)?|goodbye(?: knowhow)?|stop(?: listening| knowhow)?|(?:okay |ok )?(?:we(?:'re| are) done|go (?:back )?to sleep)|(?:okay |ok )?(?:that(?:'s| is) (?:all|enough))(?: for now)?)$/.test(
      normalized
    );
  }

  private extractWakePhrase(text: string): { matched: boolean; remainder: string } {
    const phrase = this.options.wakePhrase;
    if (!phrase) return { matched: false, remainder: text };
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\s)${escaped}(?=$|[\\s,.:;!?-])`, "i").exec(text);
    if (match) {
      const after = text
        .slice(match.index + match[0].length)
        .replace(/^[\s,.:;!?-]+/, "")
        .trim();
      return { matched: true, remainder: after };
    }

    // STT commonly renders an unfamiliar compound as nearby ordinary words
    // ("hey no how" / "hey now how"). The recognition prompt reduces that,
    // while this conservative, start-only fuzzy check keeps activation reliable.
    const expected = phrase.toLowerCase().replace(/[^a-z0-9]/g, "");
    const words = Array.from(text.matchAll(/[a-z0-9]+/gi));
    const expectedWords = phrase.trim().split(/\s+/).length;
    const maxEdits = Math.max(1, Math.floor(expected.length * 0.2));
    for (const count of [expectedWords, expectedWords + 1]) {
      if (words.length < count || words[0].index !== 0) continue;
      const candidate = words.slice(0, count).map((word) => word[0].toLowerCase()).join("");
      if (editDistance(candidate, expected) > maxEdits) continue;
      const last = words[count - 1];
      const after = text
        .slice((last.index ?? 0) + last[0].length)
      .replace(/^[\s,.:;!?-]+/, "")
      .trim();
      return { matched: true, remainder: after };
    }
    return { matched: false, remainder: text };
  }
}


export type ContinuousSpawn = (
  command: string,
  args: readonly string[]
) => ChildProcessWithoutNullStreams;

const defaultSpawn: ContinuousSpawn = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });

export interface SoxAudioBackendOptions {
  command?: string;
  sampleRate?: number;
  channels?: number;
  frameMs?: number;
  device?: string;
  spawn?: ContinuousSpawn;
  /**
   * SoX processing buffer in bytes. SoX's default (8192) delivers PCM in
   * ~256 ms bursts at 16 kHz, which delays VAD endpointing by up to a burst.
   * Default 1024 (~32 ms bursts).
   */
  bufferBytes?: number;
  /** Clock used to stamp frames (epoch ms). */
  now?: () => number;
}

/** Continuous macOS capture via SoX's `rec`; no terminal input is involved. */
export class SoxAudioBackend implements ContinuousAudioBackend {
  private readonly options: Required<Omit<SoxAudioBackendOptions, "device">> & {
    device?: string;
  };
  private child?: ChildProcessWithoutNullStreams;

  constructor(options: SoxAudioBackendOptions = {}) {
    this.options = {
      command: options.command ?? "rec",
      sampleRate: options.sampleRate ?? 16_000,
      channels: options.channels ?? 1,
      frameMs: options.frameMs ?? 20,
      device: options.device,
      spawn: options.spawn ?? defaultSpawn,
      bufferBytes: options.bufferBytes ?? 1024,
      now: options.now ?? Date.now,
    };
  }

  async *frames(signal: AbortSignal): AsyncIterable<PcmFrame> {
    if (this.child) throw new Error("SoX capture is already running");
    throwIfAborted(signal);
    // `rec` is SoX's default-device shorthand. Named CoreAudio inputs require
    // the full `sox -t coreaudio <device>` input-file syntax.
    const command = this.options.device && this.options.command === "rec"
      ? "sox"
      : this.options.command;
    const args = [
      "-q",
      ...(this.options.bufferBytes > 0 ? ["--buffer", String(this.options.bufferBytes)] : []),
      ...(this.options.device ? ["-t", "coreaudio", this.options.device] : []),
      "-t", "raw", "-b", "16", "-e", "signed-integer", "-L",
      "-c", String(this.options.channels), "-",
      // CoreAudio commonly opens at 48 kHz even when `-r 16000` is supplied.
      // An explicit SoX rate effect guarantees the raw output rate consumed by VAD.
      "rate", String(this.options.sampleRate),
    ];
    const child = this.options.spawn(command, args);
    this.child = child;
    let processError: Error | undefined;
    let stderr = "";
    const onAbort = () => child.kill("SIGTERM");
    const onError = (error: Error) => {
      processError = error;
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", onError);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });

    const bytesPerFrame = Math.max(
      2 * this.options.channels,
      Math.round(
        (this.options.sampleRate * this.options.channels * 2 * this.options.frameMs) / 1000
      )
    );
    const bytesPerMs = (this.options.sampleRate * this.options.channels * 2) / 1000;
    let pending = Buffer.alloc(0);
    try {
      for await (const raw of child.stdout) {
        // A chunk arrives when its LAST sample was captured; back-date each
        // frame by the audio that follows it so onset/end stamps stay accurate
        // even when SoX delivers several frames in one burst.
        const arrivedAt = this.options.now();
        pending = Buffer.concat([pending, Buffer.from(raw)]);
        while (pending.length >= bytesPerFrame) {
          const pcm = pending.subarray(0, bytesPerFrame);
          pending = pending.subarray(bytesPerFrame);
          const timestamp = Math.round(arrivedAt - (pending.length + bytesPerFrame) / bytesPerMs);
          yield { pcm: Buffer.from(pcm), timestamp };
        }
      }
      if (processError) throw processError;
      if (!signal.aborted && child.exitCode !== 0) {
        throw new Error(
          `SoX microphone capture exited with code ${child.exitCode}: ${stderr.trim() || "no diagnostic output"}`
        );
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      if (child.exitCode === null) child.kill("SIGTERM");
      if (this.child === child) this.child = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.child?.exitCode === null) this.child.kill("SIGTERM");
    this.child = undefined;
  }
}

export interface CommandUtteranceRecognizerOptions {
  command: string;
  /** Use `{file}` where the temporary WAV path belongs. It is appended if absent. */
  args?: string[];
  spawn?: ContinuousSpawn;
  parseOutput?: (stdout: string, stderr: string) => string;
  tempDirectory?: string;
}

/**
 * Final-utterance local recognizer adapter. For whisper.cpp, for example:
 * `{ command: "whisper-cli", args: ["-m", model, "-f", "{file}", "-nt"] }`.
 */
export class CommandUtteranceRecognizer implements UtteranceRecognizer {
  private readonly spawn: ContinuousSpawn;
  private readonly active = new Set<ChildProcessWithoutNullStreams>();
  private promptPhrases: string[] = [];

  get label(): string {
    return basename(this.options.command);
  }

  constructor(private readonly options: CommandUtteranceRecognizerOptions) {
    if (!options.command.trim()) throw new Error("A local recognizer command is required");
    this.spawn = options.spawn ?? defaultSpawn;
  }

  setPromptPhrases(phrases: string[]): void {
    this.promptPhrases = phrases;
  }

  async recognize(wav: Buffer, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const file = join(
      this.options.tempDirectory ?? tmpdir(),
      `knowhow-voice-${process.pid}-${randomUUID()}.wav`
    );
    await fs.writeFile(file, wav, { flag: "wx", mode: 0o600 });
    try {
      const configured = this.options.args ?? [];
      const hasPlaceholder = configured.some((arg) => arg.includes("{file}"));
      // Inject dynamic prompt phrases if the args don't already contain a --prompt flag.
      const hasPromptFlag = configured.some((arg) => arg === "--prompt" || arg === "-p");
      const args = configured.map((arg) => arg.replace(/\{file\}/g, file));
      if (!hasPlaceholder) {
        if (this.promptPhrases.length > 0 && !hasPromptFlag) {
          args.push("--prompt", this.promptPhrases.slice(0, 30).join(". ") + ".");
        }
        args.push(file);
      }
      const child = this.spawn(this.options.command, args);
      this.active.add(child);
      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        throwIfAborted(signal);
        if (code !== 0) {
          throw new Error(
            `Local recognizer exited with code ${code}: ${stderr.trim() || "no diagnostic output"}`
          );
        }
        return (this.options.parseOutput
          ? this.options.parseOutput(stdout, stderr)
          : stdout
        ).trim();
      } finally {
        signal.removeEventListener("abort", onAbort);
        this.active.delete(child);
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    } finally {
      await fs.unlink(file).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const child of this.active) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    this.active.clear();
  }
}


async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = nodeSpawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", () => resolve(true));
  });
}

/** Non-invasive checks suitable for a `--preflight`/`--dry-run` command. */
export async function preflightContinuousVoice(
  options: ContinuousPreflightOptions = {}
): Promise<ContinuousDiagnostic[]> {
  const platform = options.platform ?? process.platform;
  const capture = options.captureCommand ?? "rec";
  const exists = options.commandExists ?? commandExists;
  const diagnostics: ContinuousDiagnostic[] = [];

  if (platform !== "darwin") {
    diagnostics.push({
      code: "platform.unsupported",
      level: "error",
      message: `Continuous microphone capture currently targets macOS; detected ${platform}.`,
      remedy: "Use a custom ContinuousAudioBackend or the text/push-to-talk fallback.",
    });
  }

  if (await exists(capture)) {
    diagnostics.push({
      code: "capture.available",
      level: "info",
      message: `Found SoX microphone command '${capture}'.`,
    });
  } else {
    diagnostics.push({
      code: "capture.missing",
      level: "error",
      message: `Could not execute '${capture}'. Continuous capture requires SoX.`,
      remedy: "Install SoX (for example, `brew install sox`) and ensure `rec` is on PATH.",
    });
  }

  if (options.remoteRecognizer) {
    diagnostics.push({
      code: "recognizer.remote",
      level: options.wakePhrase ? "warning" : "info",
      message: options.wakePhrase
        ? "Wake phrase recognition will send completed utterances to OpenAI; wake audio is not local-only."
        : "Completed utterances will be transcribed by the configured OpenAI client.",
      remedy: options.wakePhrase
        ? "For privacy-preserving wake recognition, configure --local-stt-command and --local-stt-model."
        : "Ensure an OpenAI client/API key with whisper-1 access is configured.",
    });
  } else if (!options.recognizerCommand) {
    diagnostics.push({
      code: "recognizer.missing",
      level: "error",
      message: "No local final-utterance recognizer command is configured.",
      remedy: "Configure a local recognizer such as whisper.cpp and its model path.",
    });
  } else if (await exists(options.recognizerCommand)) {
    diagnostics.push({
      code: "recognizer.configured",
      level: "info",
      message: `Found local recognizer command '${options.recognizerCommand}'.`,
    });
  } else {
    diagnostics.push({
      code: "recognizer.missing",
      level: "error",
      message: `Could not execute local recognizer '${options.recognizerCommand}'.`,
      remedy: "Install/configure the recognizer binary and model, then retry preflight.",
    });
  }

  diagnostics.push({
    code: "microphone.permission",
    level: "warning",
    message: "Preflight does not open the microphone, so permission cannot be verified non-invasively.",
    remedy:
      "Allow microphone access for your terminal in System Settings > Privacy & Security > Microphone. Capture errors will include SoX diagnostics.",
  });
  return diagnostics;
}

