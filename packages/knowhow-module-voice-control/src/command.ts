import { existsSync } from "fs";
import { stderrSink, taggedLogger } from "./services/logger";
import { homedir } from "os";
import { basename, join } from "path";
import { buildSmartTypeAi } from "./smartTypeService";
import { SMART_TYPE_CONFIG, SMART_TYPE_PACK } from "./packs/smartType";
import { packConfigView } from "./packs/define";
import { createVoiceLogger, createVoiceServices } from "./services";
import { ensureDefaultMic, services, setupServices } from "@tyvm/knowhow/sdk";
import type { AgentInput, AgentService } from "@tyvm/knowhow/sdk";
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
} from "./audio";
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
import { allPacks } from "./packs/index";
import { RecoveryEngine, collectRecoverers } from "./recovery/engine";
import { mouseMoverFromComputerService } from "./commandMode";
import { createStandaloneComputerService } from "./computerService";
import { SpeechOutput, VoiceAgentRuntime, VoiceSessionEvent } from "./types";

/** The agent front-end logs to stderr (stdout carries --json event lines). */
const cliLog = taggedLogger("voice", stderrSink);
const toolLog = taggedLogger("tool", stderrSink);
const costLog = taggedLogger("cost", stderrSink);

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
      cliLog.info(`${event.state}`);
    }
    return;
  }

  if (event.type === "wake.activated") {
    cliLog.info(`wake word detected; listening for your request (no need to repeat it)`);
    return;
  }
  if (event.type === "wake.deactivated") {
    cliLog.info("sleeping; say the wake word when you need me");
    return;
  }
  if (event.type === "echo.suppressed") {
    cliLog.info("ignored likely playback echo");
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
      toolLog.info(`${event.event.name}`);
    } else if (event.event.type === "cost.updated") {
      costLog.info(`task $${event.event.costUsd.toFixed(6)}`);
    }
    return;
  }
  if (event.type === "playback.interrupted") {
    cliLog.info(`playback interrupted after ${event.progress.elapsedMs}ms`);
    return;
  }
  if (event.type === "session.error") {
    cliLog.info(`error: ${event.message}`);
    return;
  }
  if (event.type === "mode.changed") {
    cliLog.info(`mode: ${event.mode}`);
    return;
  }
  if (event.type === "command.matched") {
    cliLog.info(`command: ${event.phrase} (${event.source})`);
    return;
  }
  if (event.type === "command.unmatched") {
    cliLog.info(`unmatched: ${event.text}`);
    return;
  }
  if (event.type === "command.dispatched") {
    cliLog.info(`dispatched: ${event.event.phrase}`);
    return;
  }
  if (event.type === "command.latency") {
    stderrSink("info", formatLatencyLine(event.phrase, event.timing), "latency", "");
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
    cliLog.info("module registration: ok (voice-control command loaded)");
    if (
      localCommand &&
      basename(localCommand).includes("whisper") &&
      (!localModel || !existsSync(localModel))
    ) {
      hasErrors = true;
      cliLog.error(
        `error: local whisper.cpp model not found${localModel ? ` at ${localModel}` : ""}\n` +
          `        Use --local-stt-model <path> or install ${DEFAULT_LOCAL_WHISPER_MODEL}`
      );
    } else if (localModel && !options.localSttModel) {
      cliLog.info(`info: discovered local whisper model ${localModel}`);
    }
    if (options.speak && options.tts === "mlx") {
      const python = discoverMlxPython(options.ttsPython);
      const model = discoverMlxModel(options.ttsModel);
      const check = checkMlxAudio(python, model);
      cliLog.info(`info: MLX-Audio Python ${python}`);
      cliLog.info(`info: MLX-Audio model ${model}`);
      if (!check.ok) {
        hasErrors = true;
        cliLog.error(
          `error: mlx_audio is unavailable: ${check.message}\n` +
          `        Install with: brew install python@3.11 espeak-ng && ` +
          `python3.11 -m venv ${join(homedir(), ".cache", "knowhow", "mlx-audio")} && ` +
          `${join(homedir(), ".cache", "knowhow", "mlx-audio", "bin", "pip")} install mlx-audio 'misaki[en]'`
        );
      } else if (model.startsWith("/") && !existsSync(model)) {
        hasErrors = true;
        cliLog.info(`error: MLX-Audio model not found at ${model}`);
      }
    } else if (options.speak) {
      const speechCommand = process.platform === "darwin" ? "/usr/bin/say" : "/usr/bin/espeak";
      if (existsSync(speechCommand)) {
        cliLog.info(`info: found TTS command ${speechCommand}`);
      } else {
        hasErrors = true;
        cliLog.info(`error: TTS command not found at ${speechCommand}`);
      }
    }
    const diagnostics = await preflightContinuousVoice({
      captureCommand: options.device ? "sox" : "rec",
      recognizerCommand: localCommand,
      remoteRecognizer: !localCommand,
      wakePhrase: options.wakeWord,
    });
    for (const diagnostic of diagnostics) {
      cliLog.info(`${diagnostic.level}: ${diagnostic.message}`);
      if (diagnostic.remedy) cliLog.info(`        ${diagnostic.remedy}`);
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
    cliLog.info(`input device: ${device}`);
    cliLog.info(`endpointing: RMS ${vadThreshold}, command mode ${commandSilenceMs}ms silence (active at start), agent mode ${vadSilenceMs}ms silence`);
    cliLog.info(`transcription: ${localCommand ? `local (${localCommand})` : "OpenAI whisper-1"}`);
    if (localModel) {
      cliLog.info(`transcription model: ${localModel}`);
    }
  }

  // One services container for the whole run (platform, gaze, pointer, pending, clock, logger…).
  const voiceServices = createVoiceServices({
    log: createVoiceLogger({ sink: stderrSink }),
  });
  const voiceLog = (message: string) => voiceServices.log.info(message);
  // One recovery engine for the run: the session uses it, and so does the whisper prompt-bias guard.
  const recovery = new RecoveryEngine({ recoverers: collectRecoverers(allPacks()), services: voiceServices });
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
          recoverable: (plain, alternatives) => recovery.canRecover(plain, alternatives),
        })
      : undefined;
  // Don't leave an unhandled rejection if service setup throws first.
  localRecognizerPromise?.catch(() => undefined);

  const { Agents, Clients, Tools } = await setupServices();

  // Wire up smarttype AI services
  {
    const stConfig = packConfigView(voiceServices, SMART_TYPE_PACK.name, SMART_TYPE_CONFIG);
    const stProvider = stConfig.provider;
    const stModel = stConfig.model;
    // agenttype runs the same agent "hey knowhow" talks to unless overridden.
    const atAgentName = stConfig.agent ?? options.agent;
    voiceServices.ai = {
      ai: buildSmartTypeAi(Clients as any, Agents as any, atAgentName, stProvider, stModel),
      agentName: atAgentName,
    };
  }

  // Voice commands: knowhow.json + every loaded module's "voice-control.command"
  // extensions (built-ins included) — dedupe by name.
  const extensionsService = (Tools.getContext() as any).Extensions ?? services().Extensions;
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
      const service = createStandaloneComputerService();
      if (service) mouseMover = mouseMoverFromComputerService(service);
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
      extensions: extensionsService,
      services: voiceServices,
      recovery,
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
      cliLog.info(
        options.text
          ? "Voice-agent text harness. Type /stop to exit."
          : useContinuous
            ? "Voice-agent continuous mode. Speak naturally; press Ctrl-C to exit."
            : "Voice-agent push-to-talk harness. Press Enter to record; type /stop at a prompt to exit."
      );
      if (useContinuous && options.wakeWord && !localCommand) {
        cliLog.warn(
          "privacy warning: wake phrase detection uses remote OpenAI transcription. " +
            "Use --local-stt-command for local wake recognition."
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
