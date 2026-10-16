import { ChildProcess, spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { PlaybackHandle, PlaybackProgress, SpeechOutput } from "./types";

export const DEFAULT_MLX_KOKORO_MODEL = join(
  homedir(),
  ".lmstudio",
  "models",
  "mlx-community",
  "Kokoro-82M-bf16"
);
export const DEFAULT_MLX_AUDIO_PYTHON = join(
  homedir(),
  ".cache",
  "knowhow",
  "mlx-audio",
  "bin",
  "python3"
);

export interface MlxSpeechOptions {
  python?: string;
  model?: string;
  voice?: string;
  speed?: number;
  player?: string;
}

export function discoverMlxPython(explicit?: string): string {
  if (explicit) return explicit;
  return existsSync(DEFAULT_MLX_AUDIO_PYTHON) ? DEFAULT_MLX_AUDIO_PYTHON : "python3";
}

export function discoverMlxModel(explicit?: string): string {
  if (explicit) return explicit;
  return existsSync(DEFAULT_MLX_KOKORO_MODEL)
    ? DEFAULT_MLX_KOKORO_MODEL
    : "mlx-community/Kokoro-82M-bf16";
}

export function checkMlxAudio(python: string, model?: string): { ok: boolean; message?: string } {
  const imports = model?.toLowerCase().includes("kokoro")
    ? "import mlx_audio; import misaki"
    : "import mlx_audio";
  const result = spawnSync(python, ["-c", imports], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "mlx_audio could not be imported").trim();
    return { ok: false, message: detail };
  }
  if (model?.toLowerCase().includes("kokoro")) {
    const espeak = spawnSync("which", ["espeak-ng"], { encoding: "utf8" });
    if (espeak.status !== 0) return { ok: false, message: "Kokoro requires espeak-ng (brew install espeak-ng)" };
  }
  return { ok: true };
}

function waitForChild(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.once("error", (error) => reject(new Error(`Unable to start ${label}: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${signal || `code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

class MlxPlayback implements PlaybackHandle {
  readonly done: Promise<PlaybackProgress>;
  private child?: ChildProcess;
  private stopped = false;
  private readonly startedAt = Date.now();

  constructor(private readonly text: string, private readonly options: Required<MlxSpeechOptions>) {
    this.done = this.run();
  }

  async stop(): Promise<PlaybackProgress> {
    this.stopped = true;
    this.child?.kill("SIGTERM");
    return this.done;
  }

  private async run(): Promise<PlaybackProgress> {
    const directory = await mkdtemp(join(tmpdir(), "knowhow-mlx-tts-"));
    const output = join(directory, "speech.wav");
    try {
      if (this.stopped) return this.progress(false);
      this.child = spawn(this.options.python, [
        "-m", "mlx_audio.tts.generate",
        "--model", this.options.model,
        "--text", this.text,
        "--voice", this.options.voice,
        "--speed", String(this.options.speed),
        "--output_path", directory,
        "--file_prefix", "speech",
        "--audio_format", "wav",
        "--join_audio",
      ], { stdio: ["ignore", "ignore", "pipe"] });
      await waitForChild(this.child, "MLX-Audio synthesis");
      if (this.stopped) return this.progress(false);
      if (!existsSync(output)) {
        throw new Error(`MLX-Audio did not create the expected audio file at ${output}`);
      }
      this.child = spawn(this.options.player, [output], { stdio: ["ignore", "ignore", "pipe"] });
      await waitForChild(this.child, "audio playback");
      return this.progress(!this.stopped);
    } catch (error) {
      if (this.stopped) return this.progress(false);
      throw error;
    } finally {
      this.child = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  }

  private progress(completed: boolean): PlaybackProgress {
    return { text: this.text, completed, elapsedMs: Date.now() - this.startedAt };
  }
}

/** Local Apple Silicon TTS using MLX-Audio, followed by interruptible afplay playback. */
export class MlxSpeechOutput implements SpeechOutput {
  private readonly options: Required<MlxSpeechOptions>;
  private readonly active = new Set<MlxPlayback>();

  constructor(options: MlxSpeechOptions = {}) {
    this.options = {
      python: discoverMlxPython(options.python),
      model: discoverMlxModel(options.model),
      voice: options.voice || "af_heart",
      speed: options.speed ?? 1,
      player: options.player || "/usr/bin/afplay",
    };
  }

  async play(
    text: string,
    options: { generationId: string; signal: AbortSignal }
  ): Promise<PlaybackHandle> {
    const playback = new MlxPlayback(text, this.options);
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
