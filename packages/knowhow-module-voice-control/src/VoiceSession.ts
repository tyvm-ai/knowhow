import { randomUUID } from "crypto";
import type { AgentInput, InteractiveAgentHandle } from "@tyvm/knowhow/sdk";
import {
  PlaybackHandle,
  TranscriptEvent,
  TranscriptSource,
  SpeechOutput,
  VoiceAgentRuntime,
  VoiceSessionEvent,
  VoiceSessionEventPayload,
  VoiceSessionOptions,
  VoiceSessionState,
  VOICE_EVENT_VERSION,
} from "./types";
import type { VoiceMode } from "./commandMode";
import {
  ModeRouter,
  GazeFollowController,
  buildVoiceCommandContext,
  gazeNearestTime,
  matchPhrase,
  mouseMoverFromComputerService,
} from "./commandMode";
import { fetchRegisteredCommands, VoiceCommandEvent } from "./voiceHub";
import { GAZE_TIMEOUT, resolveGazeHubUrl } from "./gaze";
import { createStandaloneComputerService } from "./computerService";
import type { GazeSample } from "./eyeTracking";
import type { RegisteredVoiceCommand } from "./voiceCommands";
import { appendLatencyRecord, buildLatencyRecord } from "./latency";
import type { CommandSource, UtteranceTiming } from "./types";
import { appendCommandDecision } from "./commandLog";
import { checkAppSlot } from "./appSuggest";
import { PackRuntime } from "./packs/define";
import { allPacks } from "./packs/index";
import { createVoiceLogger, createVoiceServices } from "./services";
import type { TimerHandle } from "./services";
import type { VoiceServices } from "./services";
import {
  decideRecovery,
  inferTmuxIntent,
  isBareTmux,
  loneSubcommand,
} from "./intentRecovery";

/** How long a bare "tmux" waits for a follow-up "left"/"down"/…. */
const TMUX_LATCH_MS = 5000;

interface ActivePlayback {
  generationId: string;
  text: string;
  handle: PlaybackHandle;
}

/** Technical control/error output is useful in the terminal but should never be synthesized. */
export function isSpeakableAssistantOutput(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return !(
    /^user interrupted this ai completion\b/i.test(normalized) ||
    /^\d{3}\s+(?:your input|error\b)/i.test(normalized) ||
    /exceeds the context window/i.test(normalized) ||
    /^(?:error|exception):/i.test(normalized)
  );
}

interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
}

export class VoiceSession {
  readonly sessionId: string;
  private state: VoiceSessionState = "idle";
  private agent?: InteractiveAgentHandle;
  private playback?: ActivePlayback;
  private stopped = false;
  private readonly conversation: ConversationEntry[] = [];
  private pendingSpeechUtterance?: string;
  private recentPlayback?: { text: string; endedAt: number };
  private idleTimer?: TimerHandle;
  private sleeping = false;

  // ─── Command/agent mode ────────────────────────────────────────────────────
  private mode: VoiceMode;
  private readonly router: ModeRouter;
  private gazeFollow?: GazeFollowController;
  private hubPollTimer?: TimerHandle;
  private readonly hubUrl: string;
  private readonly mover?: import("./commandMode").MouseMover;
  private readonly services: VoiceServices;
  private readonly packRuntime: PackRuntime;
  private readonly commandHistory: unknown[] = [];

  constructor(
    private readonly runtime: VoiceAgentRuntime,
    private readonly transcripts: TranscriptSource,
    private readonly speech: SpeechOutput | undefined,
    private readonly options: VoiceSessionOptions
  ) {
    this.sessionId = options.sessionId || randomUUID();
    this.mode = options.initialMode ?? "agent";
    this.hubUrl = resolveGazeHubUrl();
    this.services =
      options.services ??
      createVoiceServices(
        options.log
          ? { log: createVoiceLogger({ sink: (_level, line) => options.log?.(line) }) }
          : {},
      );
    this.packRuntime = new PackRuntime(this.services, options.packs ?? allPacks());
    // Mishearings you've accepted before ("ghosting" → Ghostty) parse directly.
    this.services.appSuggest.loadLearnedAppAliases();

    // Use injected mouse mover if provided; otherwise try to load from computer-use.
    let mover: import("./commandMode").MouseMover | undefined = options.mouse;
    if (!mover) {
      const service = createStandaloneComputerService();
      if (service) mover = mouseMoverFromComputerService(service);
    }

    this.mover = mover;
    if (mover) {
      this.gazeFollow = new GazeFollowController(mover, { hubUrl: this.hubUrl, gaze: this.services.gaze, clock: this.services.clock });
    }

    this.router = new ModeRouter({
      onModeChanged: (newMode) => {
        this.mode = newMode;
        // The agent drives the real mouse in agent mode; a gaze-follow loop warping
        // the pointer ~30x/s would hijack its clicks (landing on whatever window is
        // under your gaze, e.g. this terminal). Say "eye control mouse" again in
        // command mode to resume.
        if (newMode === "agent") this.gazeFollow?.stop();
        this.emit({ type: "mode.changed", mode: newMode });
        // Notify the transcript source so it can adjust gate/VAD behaviour.
        this.transcripts.setGateMode?.(newMode);
        if (newMode === "command" && options.commandSilenceMs !== undefined) {
          this.transcripts.setCommandSilenceMs?.(options.commandSilenceMs);
        }
      },
      onRegisteredCommand: (command, invocation) => this.runRegisteredCommand(command, invocation),
      onDynamicCommand: (event: VoiceCommandEvent) => {
        this.emit({ type: "command.dispatched", event });
      },
      onUnmatched: (text) => {
        // emitted by routeTranscript
      },
      hubUrl: this.hubUrl,
      commands: options.commands,
    });
  }

  /** Registered commands currently active in the router. */
  getRegisteredCommands(): RegisteredVoiceCommand[] {
    return this.router.getRegisteredCommands();
  }

  /** Set when a bare "tmux" was heard: a lone direction word completes it. */
  private tmuxLatchUntil = 0;

  private async frontmostAppQuick(): Promise<string | undefined> {
    const actions = this.services.platform;
    if (!actions?.frontmostApp) return undefined;
    return actions.frontmostApp({ maxWaitMs: 400 }).catch(() => undefined);
  }

  /**
   * Try to recover an utterance the grammar didn't match.
   * Returns the canonical command text to dispatch, "handled" when it was
   * consumed (latch armed / confirmation asked), or undefined.
   */
  private async recoverIntent(text: string, utteranceId: string): Promise<string | "handled" | undefined> {
    // 1) Follow-up to a bare "tmux": "tmarks" … "left."
    if (this.tmuxLatchUntil > Date.now()) {
      const sub = loneSubcommand(text);
      if (sub) {
        this.tmuxLatchUntil = 0;
        console.log(`[voice] inferred: "${text}" → "tmux ${sub}" (follow-up to bare tmux)`);
        return `tmux ${sub}`;
      }
    }
    if (isBareTmux(text, this.services.intents) || /^tmux\.?$/i.test(text.trim())) {
      this.tmuxLatchUntil = Date.now() + TMUX_LATCH_MS;
      console.log(`[voice] heard bare "tmux" ("${text}") — say left/right/up/down/zoom within ${TMUX_LATCH_MS / 1000}s`);
      return "handled";
    }

    // 2) Fuzzy "tmux <dir>" ("too much love", "15 months left").
    const intent = inferTmuxIntent(text, this.services.intents);
    if (!intent) return undefined;
    const app = await this.frontmostAppQuick();
    const decision = decideRecovery(intent, app, this.services.intents);
    if (decision === "ignore") return undefined;
    if (decision === "run") {
      console.log(`[voice] inferred: "${text}" → "${intent.text}" (${app ? `frontmost ${app}` : "policy"}, ${intent.confidence})`);
      return intent.text;
    }
    console.log(`[voice] did you mean "${intent.text}"? (heard "${text}") — say "yes" or "no"`);
    void appendCommandDecision({
      ts: Date.now(), utteranceId, text, decision: "rejected",
      rejectedReason: `awaiting-confirm: ${intent.text}`,
    });
    this.services.pending.set({
      describe: `${intent.text} (heard "${text}")`,
      accept: async () => {
        void this.services.intents.learnTmuxPrefix(intent.heardPrefix);
        const spokenAt = Date.now();
        await this.router.routeCommandModeUtterance(
          intent.text,
          randomUUID(),
          spokenAt,
          () => gazeNearestTime(spokenAt, this.hubUrl, GAZE_TIMEOUT.fast),
        );
      },
      reject: () => undefined,
    });
    return "handled";
  }

  private async runRegisteredCommand(
    command: RegisteredVoiceCommand,
    invocation: {
      phrase: string;
      text: string;
      spokenAt: number;
      recognizedAt: number;
      gaze?: GazeSample;
      slots?: Record<string, unknown>;
      repeat?: number;
    },
  ): Promise<void> {
    const ctx = buildVoiceCommandContext({
      ...invocation,
      mouse: this.mover,
      gazeFollow: this.gazeFollow,
      setMode: (mode) => this.router.setMode(mode),
      log: (msg) => this.options.log?.(`[${command.name}] ${msg}`),
      actions: this.services.platform,
      services: this.services,
      history: this.commandHistory,
      slots: invocation.slots ?? {},
      repeat: invocation.repeat ?? 1,
    });
    // Misheard app name ("maximize ghosting")? Suggest the closest running app
    // and wait for "yes"/"no" instead of silently doing nothing.
    const spokenApp = typeof ctx.slots?.app === "string" ? (ctx.slots.app as string) : undefined;
    const actions = this.services.platform;
    if (spokenApp && actions?.listRunningApps && !invocation.slots?.__appChecked) {
      const check = await checkAppSlot({
        services: this.services,
        spoken: spokenApp,
        commandText: invocation.text,
        listRunningApps: () => actions.listRunningApps!(),
        allowInstalled: /focus|open|switch|launch/.test(command.name),
        log: (msg) => this.options.log?.(msg),
        rerun: (app) =>
          this.runRegisteredCommand(command, {
            ...invocation,
            slots: { ...(invocation.slots ?? {}), app, __appChecked: true },
          }),
      });
      if (check.status === "suggested") return;
    }
    // Handle repeatable commands: run repeat times if repeat > 1.
    const repeatCount = ctx.repeat ?? 1;
    if (repeatCount > 1 && command.repeatable !== false) {
      for (let i = 0; i < repeatCount; i++) {
        await command.run(ctx);
      }
    } else {
      await command.run(ctx);
    }
  }

  private reportLatency(
    utteranceId: string,
    phrase: string,
    source: CommandSource,
    text: string,
    timing: UtteranceTiming | undefined,
    extra: Partial<UtteranceTiming>,
  ): void {
    if (!timing) return;
    const full: UtteranceTiming = { ...timing, ...extra };
    this.emit({ type: "command.latency", utteranceId, phrase, source, timing: full });
    if (this.options.latencyLogFile) {
      void appendLatencyRecord(
        buildLatencyRecord({ utteranceId, phrase, source, text, timing: full }),
        this.options.latencyLogFile,
      );
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    this.setState("listening");
    // Apply initial mode gate and VAD settings.
    this.transcripts.setGateMode?.(this.mode);
    if (this.mode === "command" && this.options.commandSilenceMs !== undefined) {
      this.transcripts.setCommandSilenceMs?.(this.options.commandSilenceMs);
    }
    // Emit initial mode.
    this.emit({ type: "mode.changed", mode: this.mode });
    this.startHubPoll(signal);
    await this.packRuntime.start();
    try {
      for await (const event of this.transcripts.events(signal)) {
        if (signal.aborted || this.stopped) break;
        await this.routeTranscript(event, signal);
      }
      if (!signal.aborted && !this.stopped && this.agent) {
        await this.agent.done;
      }
    } catch (error) {
      if (!signal.aborted && !this.stopped) {
        this.emit({
          type: "session.error",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    } finally {
      await this.shutdown();
    }
  }

  async stop(reason = "voice session stopped"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearIdleTimer();
    this.stopHubPoll();
    this.gazeFollow?.stop();
    await this.packRuntime.stop();
    this.setState("stopping");
    await this.stopPlayback(reason);
    await this.agent?.stop(reason);
    await this.transcripts.close?.();
    await this.speech?.close?.();
    this.setState("stopped");
  }

  // ─── Hub polling (dynamic command specs) ──────────────────────────────────

  private startHubPoll(signal: AbortSignal): void {
    let polling = false;
    const poll = async () => {
      if (polling || signal.aborted) return;
      polling = true;
      try {
        const specs = await fetchRegisteredCommands(this.hubUrl);
        this.router.setDynamicSpecs(specs);
        // Update STT prompt with all active command phrases for better recognition.
        this.transcripts.setPromptPhrases?.(this.router.allPhrases());
      } catch {
        // ignore — hub may not be running
      } finally {
        polling = false;
      }
    };
    void poll();
    this.hubPollTimer = this.services.clock.setInterval(() => void poll(), 1_000);
    this.hubPollTimer.unref?.();
    signal.addEventListener("abort", () => this.stopHubPoll(), { once: true });
  }

  private stopHubPoll(): void {
    if (this.hubPollTimer) {
      this.services.clock.clearInterval(this.hubPollTimer);
      this.hubPollTimer = undefined;
    }
  }

  // ─── Transcript routing ───────────────────────────────────────────────────

  private async routeTranscript(event: TranscriptEvent, signal: AbortSignal): Promise<void> {
    if (event.type === "wake.deactivated") {
      this.sleeping = true;
      this.clearIdleTimer();
      // Sleep commands also switch back to command mode.
      this.router.setMode("command");
      this.emit({
        type: "wake.deactivated",
        utteranceId: event.utteranceId,
        reason: event.reason,
      });
      await this.stopPlayback("voice session returned to sleep");
      await this.agent?.stop("voice session returned to sleep");
      this.setState("listening");
      return;
    }

    if (event.type === "wake.activated") {
      this.sleeping = false;
      this.clearIdleTimer();
      this.emit({
        type: "wake.activated",
        utteranceId: event.utteranceId,
        phrase: event.phrase,
      });
      this.setState("listening");
      return;
    }

    if (event.type === "transcript.partial") {
      this.emit({
        type: "transcript",
        final: false,
        utteranceId: event.utteranceId,
        text: event.text,
      });
      return;
    }

    if (event.type === "speech.started") {
      if (this.playback) {
        this.pendingSpeechUtterance = event.utteranceId;
      }
      this.setState("listening");
      return;
    }

    if (event.type === "mode.changed" || event.type === "command.matched" || event.type === "command.unmatched") {
      // These come from within the router; re-emit as session events.
      return;
    }

    // ── transcript.final ────────────────────────────────────────────────────
    let text = event.text.trim();
    if (!text) return;
    this.sleeping = false;

    // Always check for mode-switch commands regardless of current mode.
    const modeSwitch = this.router.detectModeSwitch(text);
    if (modeSwitch !== undefined) {
      this.router.setMode(modeSwitch);
      this.emit({
        type: "transcript",
        final: true,
        utteranceId: event.utteranceId,
        text,
      });
      return;
    }

    // Wake phrase in command mode → switch to agent mode.
    if (this.mode === "command" && event.wakeMatched) {
      this.router.setMode("agent");
      // If there's remainder text after wake phrase, route it to the agent.
      if (text) {
        await this.routeFinalToAgent(text, event, signal, false);
      }
      return;
    }

    // Command mode: match against built-in and dynamic hooks.
    if (this.mode === "command") {
      const spokenAt = event.spokenAt ?? event.timestamp;
      const timing = event.timing;
      const voicedMs = timing?.voicedMs;
      const audioMs = timing?.audioMs;

      // Dictation mode: every utterance is typed unless it's a stop command.
      if (this.services.typing.dictation) {
        // Allow "stop dictating" / "end dictation" / "stop dictation" to exit
        const stopPhrases = ["stop dictating", "end dictation", "stop dictation"];
        const lower = text.toLowerCase().trim();
        if (!stopPhrases.includes(lower)) {
          this.emit({ type: "transcript", final: true, utteranceId: event.utteranceId, text });
          // Type the text via platform actions
          try {
            if (this.services.platform) {
              const { convertDictation } = await import("./grammar/dictation");
              const typed = convertDictation(text.replace(/\.$/, "").trim());
              if (typed) await this.services.platform.typeText(typed);
            }
          } catch (e) {
            this.options.log?.(`[voice] dictation type error: ${e}`);
          }
          return;
        }
        // Fall through to command routing so "stop dictating" is dispatched normally
      }

      // Context-aware recovery of misheard commands ("too much love" →
      // "tmux left" when a terminal is frontmost; elsewhere ask to confirm).
      // Runs before the F1 gate so a recovered/latched command isn't dropped
      // for being short ("tmarks" 240ms, then "left." 80ms).
      let recoveredCommand = false;
      if (!this.router.matchRegistered(text, "command") && !matchPhrase(text, this.router.getDynamicSpecs()).matched) {
        const recovery = await this.recoverIntent(text, event.utteranceId);
        if (recovery === "handled") return;
        if (recovery) {
          text = recovery;
          recoveredCommand = true;
        }
      }

      // F1: Check per-command minVoicedMs / maxAudioMs gates.
      // Find the best-matching command candidate first (by phrase/alias match)
      // to read its thresholds, then gate before dispatch.
      const candidateCmd = this.router.matchRegistered(text, "command");
      const minVoicedMs = (candidateCmd as any)?.minVoicedMs ?? 250;
      // Base the length gate on what was *said*, not on the command's phrase:
      // "maximize chrome" matched the one-word "maximize" command and was
      // rejected at 2540ms. One spoken word → 2.5s cap; longer phrases → 6s.
      const spokenWords = text.replace(/[^\p{L}\p{N}' ]+/gu, " ").trim().split(/\s+/).filter(Boolean).length;
      // Free-text commands ("type …", "smart type …", "agent type …") carry a
      // whole dictated sentence, so the 6s cap rejected real requests
      // (8.9s "agent type. list out all of the nuts…"). Give them 30s.
      const patterns: string[] = [
        (candidateCmd as any)?.pattern,
        ...(((candidateCmd as any)?.patterns as string[] | undefined) ?? []),
      ].filter((p): p is string => typeof p === "string");
      const takesFreeText = patterns.some((p) => /\{[^}]*:text\}/.test(p));
      const maxAudioMs = (candidateCmd as any)?.maxAudioMs ?? (
        spokenWords <= 1 ? 2500 : takesFreeText ? 30000 : 6000
      );

      if (!recoveredCommand && voicedMs !== undefined && voicedMs < minVoicedMs) {
        const reason = `voicedMs=${voicedMs} < minVoicedMs=${minVoicedMs}`;
        console.log(`[voice] rejected (F1 gate): ${reason} — "${text}"`);
        void appendCommandDecision({
          ts: Date.now(), utteranceId: event.utteranceId, text, decision: "rejected",
          rejectedReason: reason, voicedMs, audioMs,
        });
        this.emit({ type: "command.unmatched", utteranceId: event.utteranceId, text });
        return;
      }
      if (maxAudioMs !== undefined && audioMs !== undefined && audioMs > maxAudioMs) {
        const reason = `audioMs=${audioMs} > maxAudioMs=${maxAudioMs}`;
        console.log(`[voice] rejected (F1 gate): ${reason} — "${text}"`);
        void appendCommandDecision({
          ts: Date.now(), utteranceId: event.utteranceId, text, decision: "rejected",
          rejectedReason: reason, voicedMs, audioMs,
        });
        this.emit({ type: "command.unmatched", utteranceId: event.utteranceId, text });
        return;
      }

      // Gaze at speech onset is looked up lazily and only for registered
      // commands that run in-process (dynamic hub commands get gaze attached
      // by the hub itself), with a tight timeout so it can't add much latency.
      let gazeMs: number | undefined;
      const gaze = async () => {
        const startedAt = Date.now();
        try {
          return await gazeNearestTime(spokenAt, this.hubUrl, GAZE_TIMEOUT.fast);
        } finally {
          gazeMs = Date.now() - startedAt;
        }
      };

      this.emit({
        type: "transcript",
        final: true,
        utteranceId: event.utteranceId,
        text,
      });

      const result = await this.router.routeCommandModeUtterance(
        text,
        event.utteranceId,
        spokenAt,
        gaze,
        { recognizedAt: event.timing?.sttEndAt ?? event.timestamp, timing: event.timing },
      );

      if (result.matched) {
        this.emit({
          type: "command.matched",
          utteranceId: event.utteranceId,
          phrase: result.phrase,
          source: result.source,
        });
        // F6: Log accepted command decision.
        void appendCommandDecision({
          ts: Date.now(), utteranceId: event.utteranceId, text, decision: "accepted",
          phrase: result.phrase, source: result.source,
          voicedMs, audioMs,
        });
        console.log(`[voice] accepted: "${result.phrase}" (voiced=${voicedMs ?? "?"}ms, audio=${audioMs ?? "?"}ms)`);
        this.reportLatency(event.utteranceId, result.phrase, result.source, text, event.timing, {
          dispatchedAt: result.dispatchedAt ?? Date.now(),
          ...(gazeMs !== undefined ? { gazeMs } : {}),
        });
      } else {
        this.emit({
          type: "command.unmatched",
          utteranceId: event.utteranceId,
          text,
        });
        // F6: Log rejected (no match) decision.
        void appendCommandDecision({
          ts: Date.now(), utteranceId: event.utteranceId, text, decision: "rejected",
          rejectedReason: "no-match", voicedMs, audioMs,
        });
        console.log(`[voice] unmatched: "${text}" (voiced=${voicedMs ?? "?"}ms, audio=${audioMs ?? "?"}ms)`);
      }
      return;
    }

    // Agent mode: commands that opt into "agent" mode fire here too.
    const agentCommand = this.router.matchRegistered(text, "agent");
    if (agentCommand) {
      this.emit({ type: "transcript", final: true, utteranceId: event.utteranceId, text });
      const spokenAt = event.spokenAt ?? event.timestamp;
      try {
        await this.runRegisteredCommand(agentCommand, {
          phrase: agentCommand.phrase,
          text,
          spokenAt,
          recognizedAt: event.timing?.sttEndAt ?? event.timestamp,
          gaze: await gazeNearestTime(spokenAt, this.hubUrl, GAZE_TIMEOUT.fast),
        });
      } catch {
        // command errors don't propagate
      }
      const source: CommandSource = agentCommand.source === "built-in"
        ? "builtin"
        : agentCommand.source === "knowhow.json" ? "config" : "module";
      this.emit({ type: "command.matched", utteranceId: event.utteranceId, phrase: agentCommand.phrase, source });
      this.reportLatency(event.utteranceId, agentCommand.phrase, source, text, event.timing, { dispatchedAt: Date.now() });
      return;
    }

    // Agent mode: route to agent as before.
    let interruptedPlayback = false;
    if (this.pendingSpeechUtterance === event.utteranceId) {
      this.pendingSpeechUtterance = undefined;
      if (this.isLikelyPlaybackEcho(text)) {
        this.emit({ type: "echo.suppressed", utteranceId: event.utteranceId, text });
        this.setState(this.agent ? "thinking" : this.playback ? "speaking" : "listening");
        return;
      }
      const interrupted = await this.stopPlayback("barge-in");
      if (interrupted) {
        interruptedPlayback = true;
        await this.reportPlaybackInterruption(interrupted);
      }
    }
    this.clearIdleTimer();
    this.emit({
      type: "transcript",
      final: true,
      utteranceId: event.utteranceId,
      text,
    });
    await this.routeFinalToAgent(text, event, signal, interruptedPlayback);
  }

  private async routeFinalToAgent(
    text: string,
    event: { utteranceId: string; timestamp: number; activation?: string },
    signal: AbortSignal,
    interruptedPlayback: boolean,
  ): Promise<void> {
    const input: AgentInput = {
      id: event.utteranceId,
      kind: "user",
      content: text,
      timestamp: event.timestamp,
      correlationId: event.utteranceId,
      interrupt: interruptedPlayback,
      metadata: {
        activation: (event as any).activation,
        delivery: interruptedPlayback ? "barge-in" : "additional-context",
      },
    };

    this.remember({ role: "user", text });
    if (this.agent) {
      this.setState("thinking");
      if (interruptedPlayback) await this.agent.interrupt(input);
      else await this.agent.send(input);
      return;
    }

    input.content = this.contextualInput();
    this.setState("thinking");
    const handle = await this.runtime.start({
      agent: this.options.agent,
      initialInput: input,
      signal,
    });
    this.agent = handle;
    void this.consumeAgent(handle, signal);
    const clearHandle = () => {
      if (this.agent !== handle) return;
      this.agent = undefined;
      this.scheduleIdleSleep();
      if (!this.stopped) this.setState("listening");
    };
    const completed = (result: { answer: string }) => {
      if (!this.stopped && result.answer.trim()) {
        this.remember({ role: "assistant", text: result.answer.trim() });
      }
      clearHandle();
    };
    const failed = (error: unknown) => {
      if (!this.stopped && !signal.aborted) {
        this.emit({
          type: "session.error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      clearHandle();
    };
    void handle.done.then(completed, failed);
  }

  private remember(entry: ConversationEntry): void {
    this.conversation.push({ ...entry, text: entry.text.slice(0, 4_000) });
    while (this.conversation.length > 12) this.conversation.shift();
    while (
      this.conversation.length > 1 &&
      this.conversation.reduce((total, item) => total + item.text.length, 0) > 12_000
    ) {
      this.conversation.shift();
    }
  }

  /** Preserve bounded dialogue when the underlying task-scoped agent completes. */
  private contextualInput(): string {
    const latest = this.conversation[this.conversation.length - 1];
    if (this.conversation.length <= 1) return latest?.text || "";
    const transcript = this.conversation
      .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`)
      .join("\n");
    return (
      "Continue the voice conversation below. Treat it as dialogue context; respond to the " +
      `latest user turn while retaining your normal tools.\n\n${transcript}`
    );
  }

  private async consumeAgent(handle: InteractiveAgentHandle, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of handle.events(signal)) {
        this.emit({ type: "agent", event });
        if (
          event.type === "cost.updated" &&
          this.options.maxTaskCostUsd !== undefined &&
          event.costUsd >= this.options.maxTaskCostUsd
        ) {
          this.emit({
            type: "session.error",
            message:
              `Task cost $${event.costUsd.toFixed(4)} reached the ` +
              `$${this.options.maxTaskCostUsd.toFixed(4)} limit; stopping it.`,
          });
          await handle.stop("voice-control task cost limit reached");
          continue;
        }
        if (event.type !== "output.completed" || !this.speech || !event.text.trim()) continue;
        if (!isSpeakableAssistantOutput(event.text)) continue;

        await this.stopPlayback("superseded by newer agent output");
        this.setState("speaking");
        const playback = await this.speech.play(event.text, {
          generationId: event.generationId,
          signal,
        });
        const active = { generationId: event.generationId, text: event.text, handle: playback };
        this.playback = active;
        const playbackFinished = () => {
          if (this.playback === active) {
            this.playback = undefined;
            this.recentPlayback = { text: active.text, endedAt: Date.now() };
            this.scheduleIdleSleep();
            if (!this.stopped) this.setState(this.agent ? "thinking" : "listening");
          }
        };
        void playback.done.then(playbackFinished, (error) => {
          playbackFinished();
          if (!signal.aborted && !this.stopped) {
            this.emit({
              type: "session.error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
    } catch (error) {
      if (!signal.aborted && !this.stopped) {
        this.emit({
          type: "session.error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async stopPlayback(reason: string): Promise<{
    generationId: string;
    progress: Awaited<ReturnType<PlaybackHandle["stop"]>>;
  } | undefined> {
    const active = this.playback;
    if (!active) return undefined;
    this.playback = undefined;
    const progress = await active.handle.stop(reason);
    this.recentPlayback = { text: progress.text || active.text, endedAt: Date.now() };
    this.emit({
      type: "playback.interrupted",
      generationId: active.generationId,
      progress,
    });
    return { generationId: active.generationId, progress };
  }

  private async reportPlaybackInterruption(interrupted: {
    generationId: string;
    progress: Awaited<ReturnType<PlaybackHandle["stop"]>>;
  }): Promise<void> {
    if (!this.agent) return;
    await this.agent.send({
      id: randomUUID(),
      kind: "observation",
      content:
        `Speech playback was interrupted by the user after ${interrupted.progress.elapsedMs}ms. ` +
        `The attempted response was: ${JSON.stringify(interrupted.progress.text)}`,
      timestamp: Date.now(),
      interrupt: false,
      metadata: { generationId: interrupted.generationId, playback: interrupted.progress },
    });
  }

  private isLikelyPlaybackEcho(text: string): boolean {
    const reference = this.playback?.text ||
      (this.recentPlayback && Date.now() - this.recentPlayback.endedAt <= 5_000
        ? this.recentPlayback.text
        : undefined);
    if (!reference) return false;
    const words = (value: string) => value.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [];
    const candidate = words(text);
    const spoken = words(reference);
    if (candidate.length < 2 || spoken.length < 2) return false;
    const candidateText = candidate.join(" ");
    const spokenText = spoken.join(" ");
    if (spokenText.includes(candidateText)) return true;
    const spokenWords = new Set(spoken);
    return candidate.filter((word) => spokenWords.has(word)).length / candidate.length >= 0.8;
  }

  private scheduleIdleSleep(): void {
    if (this.stopped || this.sleeping || this.agent || this.playback || !this.transcripts.deactivate) return;
    this.clearIdleTimer();
    this.transcripts.renewActiveWindow?.();
    const delay = this.options.conversationIdleMs ?? 30_000;
    this.idleTimer = this.services.clock.setTimeout(() => {
      this.idleTimer = undefined;
      this.sleeping = true;
      this.transcripts.deactivate?.();
      this.emit({ type: "wake.deactivated", utteranceId: randomUUID(), reason: "inactivity" });
    }, delay);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) this.services.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async shutdown(): Promise<void> {
    if (!this.stopped) await this.stop();
  }

  private setState(state: VoiceSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "session.state", state });
  }

  private emit(event: VoiceSessionEventPayload): void {
    this.options.onEvent?.({
      ...event,
      version: VOICE_EVENT_VERSION,
      sessionId: this.sessionId,
      timestamp: Date.now(),
    } as VoiceSessionEvent);
  }
}
