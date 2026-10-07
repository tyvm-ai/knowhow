import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "child_process";
import { ContinuousAudioBackend, ContinuousDiagnostic, ContinuousPreflightOptions } from "./types";

export async function commandExists(command: string): Promise<boolean> {
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
