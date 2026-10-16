import { randomUUID } from "crypto";
import { basename, join } from "path";
import type { TranscriptEvent, TranscriptSource, UtteranceTiming } from "../types";
import { AsyncEventQueue, systemClock, throwIfAborted } from "./eventQueue";
import { editDistance, isMeaningfulCommandTranscript, isMeaningfulTranscript, stripRecognizerArtifacts } from "./transcriptText";
import { ContinuousAudioBackend, ContinuousClock, ContinuousLogger, ContinuousTranscriptOptions, PcmFrame, UtteranceRecognizer } from "./types";
import { frameDurationMs, pcmRms, summariseNoiseFloor } from "./vad";
import { pcmToWav } from "./wav";

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
