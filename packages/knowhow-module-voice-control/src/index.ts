import type {
  InitParams,
  KnowhowModule,
  ModulePlugin,
} from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { runVoiceAgent, VoiceAgentCommandOptions } from "./command";
import { runVoiceCommandsList } from "./commandsCli";
import { BUILTIN_VOICE_COMMANDS } from "./voiceCommands";
import { runEyeTracking } from "./eyeTracking";
import { GazePlugin } from "./GazePlugin";
import { gazeExtension, voiceExtension } from "./extensions";
import META_PACK from "./packs/meta";
import GAZE_MOUSE_PACK from "./packs/gazeMouse";
import TEXT_PACK from "./packs/text";
import KEYS_PACK from "./packs/keys";
import { WINDOWS_PACK } from "./packs/windows";
import { SYSTEM_PACK } from "./packs/system";
import { HINTS_PACK, registerHintSlot } from "./packs/hints";
import { TMUX_PACK } from "./packs/tmux";
import { BROWSER_PACK } from "./packs/browser";
import { hintsExtension } from "./extensions";
import { parseUtterance } from "./grammar";
import { collectVoiceCommands, BUILTIN_VOICE_COMMANDS as BUILTINS } from "./voiceCommands";
import { runHintsCli } from "./hintsCli";
import { SMART_TYPE_PACK } from "./packs/smartType";

export * from "./types";
export * from "./VoiceSession";
export * from "./adapters";
export * from "./continuous";
export * from "./mlxSpeech";
export * from "./command";
export * from "./eyeTracking";
export * from "./GazePlugin";
export * from "./voiceHub";
export * from "./commandMode";
export * from "./extensions";
export * from "./voiceCommands";
export * from "./commandsCli";
export * from "./axEnabler";
export * from "./latency";
export * from "./whisperServer";

/**
 * Action for `knowhow voice-agent [subcommand]` / `knowhow voice-control [subcommand]`.
 * `voice-control commands` lists registered voice commands; no subcommand runs the agent.
 * Works with both commander v2 (options on the command object) and v14
 * (options object as the second argument).
 */
export async function voiceControlAction(subcommand: unknown, argsOrOpts: any, optsOrCmd?: any): Promise<void> {
  // Commander v14: action(subcommand, extraArgs[], options, command)
  // Commander v2:  action(subcommand, options)
  // We registered [subcommand] [args...], so argsOrOpts may be the variadic args array.
  let extraArgs: string[] = [];
  let options: VoiceAgentCommandOptions;
  if (Array.isArray(argsOrOpts)) {
    extraArgs = argsOrOpts;
    options = optsOrCmd as VoiceAgentCommandOptions;
  } else {
    options = argsOrOpts as VoiceAgentCommandOptions;
  }
  if (typeof subcommand !== "string") {
    // Defensive: if no positional slot was filled, some commander versions
    // pass the options/command object first.
    const resolved = subcommand && typeof subcommand === "object" ? (subcommand as VoiceAgentCommandOptions) : options;
    return runVoiceAgent(resolved as VoiceAgentCommandOptions);
  }
  if (subcommand === "commands") {
    await runVoiceCommandsList({ json: !!(options as any)?.json });
    return;
  }
  if (subcommand === "parse") {
    // `knowhow voice-control parse "<utterance>" [--json]`
    // The utterance comes from the variadic args, remaining args, or --once option
    const utterance =
      extraArgs[0] ??
      (options as any)?.args?.[0] ??
      (options as any)?._?.[0] ??
      (options as any)?.once ??
      "";
    if (!utterance) {
      process.stderr.write('Usage: knowhow voice-control parse "<utterance>" [--json]\n');
      process.exit(1);
    }
    const allCommands = collectVoiceCommands({
      builtins: [
        ...BUILTINS,
        ...META_PACK,
        ...GAZE_MOUSE_PACK,
        ...TEXT_PACK,
        ...KEYS_PACK,
        ...WINDOWS_PACK,
        ...SYSTEM_PACK,
        ...HINTS_PACK,
        ...TMUX_PACK,
        ...BROWSER_PACK,
        ...SMART_TYPE_PACK,
      ],
    });
    const result = parseUtterance(utterance, allCommands);
    if ((options as any)?.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      if (result.kind === "none") {
        process.stdout.write(`No match for: "${utterance}"\n`);
      } else if (result.kind === "match") {
        process.stdout.write(`Matched: ${result.result.command.phrase} (score=${result.result.score}, repeat=${result.result.repeat})\nSlots: ${JSON.stringify(result.result.slots)}\n`);
      } else {
        process.stdout.write(`Chain (${result.results.length} commands):\n`);
        for (const r of result.results) {
          process.stdout.write(`  ${r.command.phrase} (score=${r.score}, repeat=${r.repeat}) slots=${JSON.stringify(r.slots)}\n`);
        }
      }
    }
    return;
  }
  if (subcommand === "hints") {
    // `knowhow voice-control hints [--json] [--x N] [--y N] [--all] [--app NAME]`
    const o = options as any;
    const xVal = o?.x ?? extraArgs.find((_: string, i: number) => extraArgs[i - 1] === "--x");
    const yVal = o?.y ?? extraArgs.find((_: string, i: number) => extraArgs[i - 1] === "--y");
    await runHintsCli({
      json: !!o?.json,
      x: xVal !== undefined ? Number(xVal) : undefined,
      y: yVal !== undefined ? Number(yVal) : undefined,
      all: !!o?.all,
      app: o?.app ?? undefined,
      hubUrl: o?.hubUrl ?? undefined,
      source: o?.source ?? undefined,
      move: !!o?.move,
      density: o?.density ?? undefined,
    });
    return;
  }
  throw new Error(`Unknown voice-control subcommand "${subcommand}". Available: commands, parse, hints`);
}

interface VoiceControlConfig {
  tts?: {
    provider?: "system" | "mlx";
    model?: string;
    voice?: string;
    python?: string;
    speed?: number;
  };
  eyeTracking?: {
    port?: number;
    host?: string;
    model?: string;
    python?: string;
    cameraIndex?: number;
  };
}

const plugins: ModulePlugin[] = [
  { name: "gaze", plugin: GazePlugin },
];

const voiceControlModule: KnowhowModule = {
  extensions: [
    gazeExtension,
    voiceExtension,
    hintsExtension,
    ...BUILTIN_VOICE_COMMANDS,
    // Core packs
    ...META_PACK,
    ...GAZE_MOUSE_PACK,
    ...TEXT_PACK,
    ...KEYS_PACK,
    // Windows agent packs
    ...WINDOWS_PACK,
    ...SYSTEM_PACK,
    // Hints agent pack
    ...HINTS_PACK,
    // tmux pack
    ...TMUX_PACK,
    // Chrome tabs by name (browser MCP, AppleScript fallback)
    ...BROWSER_PACK,
    // smarttype / agenttype pack
    ...SMART_TYPE_PACK,
  ],
  async register(params: InitParams) {
    const program = params.context?.Program;
    if (!program) return;
    const config = params.config as typeof params.config & {
      voiceControl?: VoiceControlConfig;
    };
    const tts = config.voiceControl?.tts;

    if (!program.commands.some((command) => command.name() === "voice-agent")) {
      program
        .command("voice-agent")
        .alias("voice-control")
        .arguments("[subcommand] [args...]")
        .description(
          "Run an interactive Knowhow agent using voice input. " +
            "`voice-control commands [--json]` lists registered voice commands. " +
            "`voice-control parse \"<utterance>\" [--json]` parses an utterance against all commands. " +
            "`voice-control hints [--json] [--x N --y N] [--all] [--app NAME] [--source auto|ax|visual|both] [--density few|normal|more|all] [--move]` dry-runs the gaze hint selector and shows the overlay for 4s."
        )
        .option(
          "--agent <name>",
          "Registered Knowhow agent to run",
          "ComputerUseAgent"
        )
        .option(
          "--model <model>",
          "Override the selected agent's reasoning model"
        )
        .option(
          "--provider <provider>",
          "Override the selected agent's reasoning provider"
        )
        .option(
          "--once <text>",
          "Send one utterance without opening a microphone"
        )
        .option(
          "--text",
          "Use the typed terminal harness instead of the microphone"
        )
        .option(
          "--continuous",
          "Continuously capture speech using local VAD (the default)"
        )
        .option(
          "--wake-word <phrase>",
          "Gate turns on a wake phrase",
          "hey knowhow"
        )
        .option(
          "--wake-window-ms <ms>",
          "Wake-free idle window after a completed task",
          "30000"
        )
        .option(
          "--local-stt-command <path>",
          "Local final-utterance recognizer executable"
        )
        .option(
          "--local-stt-model <path>",
          "whisper.cpp model used by the local recognizer"
        )
        .option(
          "--stt-prompt <text>",
          "Vocabulary prompt used to bias speech recognition"
        )
        .option("--device <name>", "SoX/CoreAudio input device")
        .option(
          "--vad-threshold <rms>",
          "Local VAD RMS threshold (0..1)",
          "0.012"
        )
        .option(
          "--speech-threshold <rms>",
          "RMS (0..1) considered speech; alias of --vad-threshold (raise if keyboard noise keeps the VAD open)"
        )
        .option(
          "--stt-backend <backend>",
          "Local whisper backend: server (persistent whisper-server, default when installed) or cli (whisper-cli per utterance)"
        )
        .option(
          "--vad-debug",
          "Log the ambient RMS noise floor every 10s"
        )
        .option(
          "--no-latency-log",
          "Do not append per-command latency to ~/.cache/knowhow/voice/latency.jsonl"
        )
        .option(
          "--vad-silence-ms <ms>",
          "Silence duration that ends an utterance",
          "1000"
        )
        .option(
          "--command-silence-ms <ms>",
          "Silence duration that ends an utterance in command mode (default: 350)",
          "350"
        )
        .option(
          "--max-task-cost-usd <usd>",
          "Stop a voice task when its cost reaches this amount"
        )
        .option("--speak", "Read assistant output aloud")
        .option(
          "--tts <provider>",
          "Speech provider: system or mlx",
          tts?.provider || "system"
        )
        .option(
          "--tts-model <path-or-id>",
          "MLX-Audio model path or Hugging Face id",
          tts?.model
        )
        .option(
          "--tts-voice <name>",
          "MLX-Audio voice name",
          tts?.voice || "af_heart"
        )
        .option(
          "--tts-python <path>",
          "Python executable with mlx_audio installed",
          tts?.python
        )
        .option(
          "--tts-speed <rate>",
          "MLX-Audio speaking speed",
          String(tts?.speed ?? 1)
        )
        .option("--json", "Emit versioned session events as JSON Lines")
        .option(
          "--preflight",
          "Check platform and audio/STT prerequisites without loading services"
        )
        .option(
          "--x <pixels>",
          "hints: override gaze/mouse X coordinate"
        )
        .option(
          "--y <pixels>",
          "hints: override gaze/mouse Y coordinate"
        )
        .option(
          "--all",
          "hints: show candidates for the whole window (not just near gaze)"
        )
        .option(
          "--app <name>",
          "hints: focus this application before querying (e.g. 'Google Chrome')"
        )
        .option(
          "--source <source>",
          "hints: candidate source auto|ax|visual|both (visual = screenshot OCR + box detection)"
        )
        .option(
          "--move",
          "hints: move the mouse to each labelled hint in turn"
        )
        .option(
          "--density <density>",
          "hints: how many hints to show: few|normal|more|all (default normal)"
        )
        .option(
          "--hub-url <url>",
          "hints: eye-tracker hub URL",
          "http://127.0.0.1:7465"
        )
        .action(voiceControlAction);
    }

    if (
      !program.commands.some((command) => command.name() === "eye-tracking")
    ) {
      const eye = config.voiceControl?.eyeTracking;
      program
        .command("eye-tracking")
        .alias("gaze-control")
        .description(
          "Calibrate webcam gaze tracking and start the native background tracker"
        )
        .option(
          "--port <port>",
          "Local calibration server port",
          String(eye?.port ?? 7465)
        )
        .option(
          "--host <host>",
          "Local calibration server host",
          eye?.host ?? "127.0.0.1"
        )
        .option(
          "--model <path>",
          "Cached MediaPipe face-landmarker model",
          eye?.model
        )
        .option("--python <path>", "Python executable with mediapipe/opencv", eye?.python)
        .option("--camera-index <index>", "Webcam index for the native tracker (default: the camera saved with calibration)", eye?.cameraIndex === undefined ? undefined : String(eye.cameraIndex))
        .option(
          "--no-native-overlay",
          "Disable the click-through desktop gaze box"
        )
        .option("--no-open", "Do not open the calibration page automatically")
        .option("--json", "Stream desktop gaze estimates as JSON Lines")
        .action(runEyeTracking);
    }
  },
  async init() {
    // Register the 'hint' slot type with the grammar engine.
    registerHintSlot();
  },
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default voiceControlModule;
