import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { throwIfAborted } from "./eventQueue";
import { ContinuousSpawn, defaultSpawn } from "./sox";
import { UtteranceRecognizer } from "./types";

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
