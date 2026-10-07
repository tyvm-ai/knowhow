import { existsSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { setSmartTypeServices, buildSmartTypeAi } from "./smartTypeService";
import type { AgentService } from "@tyvm/knowhow/ts_build/src/services/AgentService";
import type { AgentInput } from "@tyvm/knowhow/ts_build/src/services/InteractiveAgentRuntime";
import { ensureDefaultMic } from "@tyvm/knowhow/ts_build/src/microphone";
import {
  OneShotTranscriptSource,
  OpenAIUtteranceRecognizer,
  PushToTalkTranscriptSource,
  SystemSpeechOutput,
  TextTranscriptSource,
} from "./adapters";
import {
  ContinuousTranscriptSource,
  SoxAudioBackend,
  UtteranceRecognizer,
  preflightContinuousVoice,
} from "./continuous";
import { createWhisperRecognizer } from "./whisperServer";
import { collectVoiceCommands, readKnowhowConfig } from "./voiceCommands";
import { DEFAULT_LATENCY_LOG, formatLatencyLine } from "./latency";
import {
  checkMlxAudio,
  discoverMlxModel,
  discoverMlxPython,
  MlxSpeechOutput,
} from "./mlxSpeech";
import { VoiceSession } from "./VoiceSession";
import { mouseMoverFromComputerService } from "./commandMode";
import { SpeechOutput, VoiceAgentRuntime, VoiceSessionEvent } from "./types";

export interface VoiceAgentCommandOptions {
  agent: string;
  model?: string;
  provider?: string;
  once?: string;
  text?: boolean;
  continuous?: boolean;
  speak?: boolean;
  json?: boolean;
  wakeWord?: string;
  wakeWindowMs?: string;
  localSttCommand?: string;
  localSttModel?: string;
  sttPrompt?: string;
  device?: string;
  vadThreshold?: string;
  /** Alias of --vad-threshold (RMS 0..1 considered speech). */
  speechThreshold?: string;
  vadSilenceMs?: string;
  /** "cli" | "server" (default: server when whisper-server is installed). */
  sttBackend?: string;
  /** Log the ambient RMS noise floor every 10 s. */
  vadDebug?: boolean;
  /** Disable ~/.cache/knowhow/voice/latency.jsonl. */
  latencyLog?: boolean;
  commandSilenceMs?: string;
  tts?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsPython?: string;
  ttsSpeed?: string;
  maxTaskCostUsd?: string;
  preflight?: boolean;
}

export class KnowhowAgentRuntime implements VoiceAgentRuntime {
  constructor(private readonly agents: AgentService) {}

  start(options: { agent: string; initialInput: AgentInput; signal?: AbortSignal }) {
    return this.agents.startInteractive(options.agent, {
      initialInput: options.initialInput,
      signal: options.signal,
    });
  }
}

function renderEvent(event: VoiceSessionEvent, json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);

    return;
  }

  if (event.type === "session.state") {
    if (["listening", "thinking", "speaking"].includes(event.state)) {
      process.stderr.write(`[voice] ${event.state}\n`);
    }
    return;
  }

  if (event.type === "wake.activated") {
    process.stderr.write(
      `[voice] wake word detected; listening for your request (no need to repeat it)\n`
    );
    return;
  }
  if (event.type === "wake.deactivated") {
    process.stderr.write("[voice] sleeping; say the wake word when you need me\n");
    return;
  }
  if (event.type === "echo.suppressed") {
    process.stderr.write("[voice] ignored likely playback echo\n");
    return;
  }
  if (event.type === "transcript") {
    process.stdout.write(`${event.final ? "you" : "heard"}: ${event.text}\n`);
    return;
  }
  if (event.type === "agent") {
    if (event.event.type === "output.completed") {
      process.stdout.write(`assistant: ${event.event.text}\n`);
    } else if (event.event.type === "tool.started") {
      process.stderr.write(`[tool] ${event.event.name}\n`);
    } else if (event.event.type === "cost.updated") {
      process.stderr.write(`[cost] task $${event.event.costUsd.toFixed(6)}\n`);
    }
    return;
  }
  if (event.type === "playback.interrupted") {
    process.stderr.write(`[voice] playback interrupted after ${event.progress.elapsedMs}ms\n`);
    return;
  }
  if (event.type === "session.error") {
    process.stderr.write(`[voice] error: ${event.message}\n`);
    return;
  }
  if (event.type === "mode.changed") {
    process.stderr.write(`[voice] mode: ${event.mode}\n`);
    return;
  }
  if (event.type === "command.matched") {
    process.stderr.write(`[voice] command: ${event.phrase} (${event.source})\n`);
    return;
  }
  if (event.type === "command.unmatched") {
    process.stderr.write(`[voice] unmatched: ${event.text}\n`);
    return;
  }
  if (event.type === "command.dispatched") {
    process.stderr.write(`[voice] dispatched: ${event.event.phrase}\n`);
    return;
  }
  if (event.type === "command.latency") {
    process.stderr.write(`${formatLatencyLine(event.phrase, event.timing)}\n`);
  }
}

function numberOption(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function positiveOption(value: string | undefined, fallback: number, name: string): number {
  const parsed = numberOption(value, fallback, name);
  if (parsed === 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function speechOutput(options: VoiceAgentCommandOptions): SpeechOutput | undefined {
  if (!options.speak) return undefined;
  const provider = options.tts || "system";
  if (provider === "system") return new SystemSpeechOutput();
  if (provider === "mlx") {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("MLX-Audio speech requires macOS on Apple Silicon");
    }
    return new MlxSpeechOutput({
      python: options.ttsPython,
      model: options.ttsModel,
      voice: options.ttsVoice,
      speed: positiveOption(options.ttsSpeed, 1, "--tts-speed"),
    });
  }
  throw new Error(`Unsupported --tts provider '${provider}'. Use system or mlx.`);
}

function rmsOption(value: string | undefined, name = "--vad-threshold"): number {
  const parsed = numberOption(value, 0.012, name);
  if (parsed > 1) {
    throw new Error(`${name} must be in the range 0..1`);
  }
  return parsed;
}

export const DEFAULT_LOCAL_WHISPER_MODEL = join(
  homedir(),
  ".cache",
  "knowhow",
  "whisper",
  "ggml-base.bin"
);

// Default to the smaller English model for interactive latency. Larger models
// remain available through --local-stt-model when accuracy matters more.
const LOCAL_WHISPER_MODELS = [
  "ggml-small.en.bin",
  "ggml-large-v3-turbo.bin",
  "ggml-base.en.bin",
  "ggml-base.bin",
].map((name) => join(homedir(), ".cache", "knowhow", "whisper", name));

/** Explicit model paths win; otherwise discover Knowhow's macOS whisper.cpp cache. */
export function localWhisperModel(explicit?: string): string | undefined {
  if (explicit) return explicit;
  return process.platform === "darwin" ? LOCAL_WHISPER_MODELS.find(existsSync) : undefined;
}

/** Prefer a locally installed whisper.cpp when its standard model is available. */
export function localWhisperCommand(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (!localWhisperModel()) return undefined;
  const candidates = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
  return candidates.find(existsSync);
}

export async function runVoiceAgent(options: VoiceAgentCommandOptions): Promise<void> {
  // Commander 2 exposes EventEmitter.once on the command object when --once
  // was omitted, so only a string is an actual one-shot request.
  const once = typeof options.once === "string" ? options.once : undefined;
  const useContinuous = !once && !options.text;
  const localCommand = localWhisperCommand(options.localSttCommand);
  const localModel = localCommand
    ? localWhisperModel(options.localSttModel)
    : undefined;
  // Whisper prompts bias spelling and vocabulary; they are not instructions.
  // Include the wake phrase by default so product names such as "Knowhow" are
  // considerably less likely to be split into ordinary words.
  const sttPrompt = options.sttPrompt ?? (options.wakeWord
    ? `${options.wakeWord}. Knowhow voice control.`
    : undefined);
  if (
    !options.preflight &&
    localCommand &&
    basename(localCommand).includes("whisper") &&
    !localModel
  ) {
    throw new Error(
      `Local whisper.cpp requires --local-stt-model <path>; default not found at ${DEFAULT_LOCAL_WHISPER_MODEL}`
    );
  }
  if (options.preflight) {
    let hasErrors = false;
    process.stderr.write("[voice] module registration: ok (voice-control command loaded)\n");
    if (
      localCommand &&
      basename(localCommand).includes("whisper") &&
      (!localModel || !existsSync(localModel))
    ) {
      hasErrors = true;
      process.stderr.write(
        `[voice] error: local whisper.cpp model not found${localModel ? ` at ${localModel}` : ""}\n` +
          `        Use --local-stt-model <path> or install ${DEFAULT_LOCAL_WHISPER_MODEL}\n`
      );
    } else if (localModel && !options.localSttModel) {
      process.stderr.write(`[voice] info: discovered local whisper model ${localModel}\n`);
    }
    if (options.speak && options.tts === "mlx") {
      const python = discoverMlxPython(options.ttsPython);
      const model = discoverMlxModel(options.ttsModel);
      const check = checkMlxAudio(python, model);
      process.stderr.write(`[voice] info: MLX-Audio Python ${python}\n`);
      process.stderr.write(`[voice] info: MLX-Audio model ${model}\n`);
      if (!check.ok) {
        hasErrors = true;
        process.stderr.write(
          `[voice] error: mlx_audio is unavailable: ${check.message}\n` +
          `        Install with: brew install python@3.11 espeak-ng && ` +
          `python3.11 -m venv ${join(homedir(), ".cache", "knowhow", "mlx-audio")} && ` +
          `${join(homedir(), ".cache", "knowhow", "mlx-audio", "bin", "pip")} install mlx-audio 'misaki[en]'\n`
        );
      } else if (model.startsWith("/") && !existsSync(model)) {
        hasErrors = true;
        process.stderr.write(`[voice] error: MLX-Audio model not found at ${model}\n`);
      }
    } else if (options.speak) {
      const speechCommand = process.platform === "darwin" ? "/usr/bin/say" : "/usr/bin/espeak";
      if (existsSync(speechCommand)) {
        process.stderr.write(`[voice] info: found TTS command ${speechCommand}\n`);
      } else {
        hasErrors = true;
        process.stderr.write(`[voice] error: TTS command not found at ${speechCommand}\n`);
      }
    }
    const diagnostics = await preflightContinuousVoice({
      captureCommand: options.device ? "sox" : "rec",
      recognizerCommand: localCommand,
      remoteRecognizer: !localCommand,
      wakePhrase: options.wakeWord,
    });
    for (const diagnostic of diagnostics) {
      process.stderr.write(`[voice] ${diagnostic.level}: ${diagnostic.message}\n`);
      if (diagnostic.remedy) process.stderr.write(`        ${diagnostic.remedy}\n`);
      if (diagnostic.level === "error") hasErrors = true;
    }
    if (hasErrors) {
      throw new Error("Voice-control preflight failed; resolve the errors above and retry.");
    }
    return;
  }

  // Reuse the microphone selected by /voice. If none has been saved yet,
  // present that same picker once and persist the result for future runs.
  const device = useContinuous
    ? options.device || (await ensureDefaultMic())
    : options.device;
  const vadThreshold = options.speechThreshold !== undefined
    ? rmsOption(options.speechThreshold, "--speech-threshold")
    : rmsOption(options.vadThreshold);
  const vadSilenceMs = numberOption(options.vadSilenceMs, 1_000, "--vad-silence-ms");
  const wakeWindowMs = numberOption(options.wakeWindowMs, 30_000, "--wake-window-ms");
  const commandSilenceMs = numberOption(options.commandSilenceMs, 350, "--command-silence-ms");
  if (useContinuous) {
    process.stderr.write(`[voice] input device: ${device}\n`);
    process.stderr.write(
      `[voice] endpointing: RMS ${vadThreshold}, command mode ${commandSilenceMs}ms silence (active at start), agent mode ${vadSilenceMs}ms silence\n`
    );
    process.stderr.write(
      `[voice] transcription: ${localCommand ? `local (${localCommand})` : "OpenAI whisper-1"}\n`
    );
    if (localModel) {
      process.stderr.write(`[voice] transcription model: ${localModel}\n`);
    }
  }

  const voiceLog = (message: string) => process.stderr.write(`[voice] ${message}\n`);
  // Start the persistent whisper-server (model load) in parallel with service setup.
  const localRecognizerPromise: Promise<UtteranceRecognizer> | undefined =
    useContinuous && localCommand
      ? createWhisperRecognizer({
          cliCommand: localCommand,
          model: localModel,
          cliArgs: localModel
            ? [
                "-m", localModel, "-f", "{file}", "-nt", "-np",
                ...(sttPrompt ? ["--prompt", sttPrompt] : []),
              ]
            : ["{file}"],
          prompt: sttPrompt,
          backend: options.sttBackend,
          // F2: Enable verbose_json by default so no_speech_prob is available
          // for confidence gating in command mode. Degrades gracefully when
          // the whisper-server binary doesn't support the field.
          verboseJson: true,
          log: voiceLog,
        })
      : undefined;
  // Don't leave an unhandled rejection if service setup throws first.
  localRecognizerPromise?.catch(() => undefined);

  const { setupServices } = await import(
    "@tyvm/knowhow/ts_build/src/commands/services"
  );
  const { Agents, Clients, Tools } = await setupServices();

  // Wire up smarttype AI services
  {
    const config = readKnowhowConfig() as any;
    const stConfig = config?.voiceControl?.smartType ?? {};
    const atConfig = config?.voiceControl?.agentType ?? {};
    const stProvider = process.env.KNOWHOW_SMARTTYPE_PROVIDER ?? stConfig.provider ?? "anthropic";
    const stModel = process.env.KNOWHOW_SMARTTYPE_MODEL ?? stConfig.model ?? "claude-sonnet-4-6";
    // agenttype runs the same agent "hey knowhow" talks to unless overridden.
    const atAgentName = atConfig.agent ?? options.agent;
    setSmartTypeServices({
      ai: buildSmartTypeAi(Clients as any, Agents as any, atAgentName, stProvider, stModel),
      agentName: atAgentName,
    });
  }

  // Voice commands: knowhow.json + every loaded module's "voice-control.command"
  // extensions (built-ins included) — dedupe by name.
  const extensionsService = (Tools.getContext() as any).Extensions ?? (() => {
    try {
      return require("@tyvm/knowhow/ts_build/src/services").services().Extensions;
    } catch {
      return undefined;
    }
  })();
  const voiceCommands = collectVoiceCommands({
    extensions: extensionsService,
    config: readKnowhowConfig(),
    warn: (msg) => voiceLog(`warning: ${msg}`),
  });
  // Collect unique pack names from command names (e.g. "voice-control.meta.*" → "meta")
  const packNames = [...new Set(voiceCommands.map((c) => {
    const m = c.name.match(/^voice-control\.([^.]+)\./);
    return m ? m[1] : c.source === "built-in" ? "built-in" : c.source;
  }))];
  voiceLog(
    `voice commands: ${voiceCommands.length} registered (packs: ${packNames.join(", ")}); see \`knowhow voice-control commands\``
  );

  // Build a mouse mover from the computer-use module if available, so VoiceSession
  // doesn't need to require it directly (enabling test injection).
  let mouseMover: import("./commandMode").MouseMover | undefined;
  try {
    const cuCtx = Tools.getContext().ComputerUse as any;
    if (cuCtx && typeof cuCtx.moveMouse === "function") {
      mouseMover = mouseMoverFromComputerService(cuCtx);
    } else {
      const cu = require("@tyvm/knowhow-module-computer-use") as any;
      const service = new cu.ComputerService();
      const driver = cu.RustCoreDriver?.tryLoad?.();
      if (driver) {
        service.registerDriver(driver);
        mouseMover = mouseMoverFromComputerService(service);
      }
    }
  } catch {
    // computer-use optional
  }
  if (!Agents.listAgents().includes(options.agent)) {
    throw new Error(
      `Agent ${options.agent} not found. Options are: ${Agents.listAgents().join(", ")}`
    );
  }
  const selectedAgent = Agents.getAgent(options.agent) as any;
  if (options.model || options.provider) {
    if (typeof selectedAgent.setModel !== "function" ||
        typeof selectedAgent.setProvider !== "function") {
      throw new Error(`Agent ${options.agent} does not support model/provider overrides`);
    }
    const model = options.model || selectedAgent.getModel?.();
    const provider = options.provider || selectedAgent.getProvider?.();
    if (!model || !provider) {
      throw new Error(`Both model and provider must be resolvable for agent ${options.agent}`);
    }
    if (typeof selectedAgent.setModelPreferences === "function") {
      selectedAgent.setModelPreferences([{ model, provider }]);
    } else {
      selectedAgent.setModel(model);
      selectedAgent.setProvider(provider);
    }
  }

  const transcripts = once
    ? new OneShotTranscriptSource(once)
    : options.text
      ? new TextTranscriptSource()
      : useContinuous
        ? new ContinuousTranscriptSource(
            new SoxAudioBackend({ device }),
            localRecognizerPromise
              ? await localRecognizerPromise
              : new OpenAIUtteranceRecognizer(Clients, "whisper-1", sttPrompt),
            {
              wakePhrase: options.wakeWord,
              activeWindowMs: wakeWindowMs,
              speechThreshold: vadThreshold,
              silenceMs: vadSilenceMs,
            },
            undefined,
            (level, message) => {
              if (level === "debug" && !options.vadDebug) return;
              voiceLog(message);
            }
          )
        : new PushToTalkTranscriptSource();
  const speech = speechOutput(options);
  const controller = new AbortController();
  const session = new VoiceSession(
    new KnowhowAgentRuntime(Agents),
    transcripts,
    speech,
    {
      agent: options.agent,
      conversationIdleMs: wakeWindowMs,
      commandSilenceMs,
      // `--once "<text>"` is a single request for the agent; starting in
      // command mode would just report it as an unmatched command and exit.
      initialMode: once ? "agent" : "command",
      mouse: mouseMover,
      commands: voiceCommands,
      latencyLogFile: options.latencyLog === false ? undefined : DEFAULT_LATENCY_LOG,
      log: voiceLog,
      maxTaskCostUsd: options.maxTaskCostUsd === undefined
        ? undefined
        : positiveOption(options.maxTaskCostUsd, 0, "--max-task-cost-usd"),
      onEvent: (event) => renderEvent(event, options.json),
    }
  );

  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!once) {
      process.stderr.write(
        options.text
          ? "Voice-agent text harness. Type /stop to exit.\n"
          : useContinuous
            ? "Voice-agent continuous mode. Speak naturally; press Ctrl-C to exit.\n"
            : "Voice-agent push-to-talk harness. Press Enter to record; type /stop at a prompt to exit.\n"
      );
      if (useContinuous && options.wakeWord && !localCommand) {
        process.stderr.write(
          "[voice] privacy warning: wake phrase detection uses remote OpenAI transcription. " +
            "Use --local-stt-command for local wake recognition.\n"
        );
      }
    }
    await session.run(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await session.stop();
  }
}
