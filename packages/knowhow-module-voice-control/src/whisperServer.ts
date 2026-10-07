/**
 * Persistent whisper.cpp recognizer.
 *
 * Spawning `whisper-cli` per utterance reloads the model every time: on an M-series
 * Mac with ggml-small.en that's ~166 ms load + ~83 ms encode + ~25 ms decode
 * (≈380 ms wall per call). `whisper-server` keeps the model resident and
 * answers POST /inference in ≈80 ms for a one-word command.
 */

import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "child_process";
import { createServer } from "net";
import { existsSync } from "fs";
import { basename } from "path";
import { CommandUtteranceRecognizer, UtteranceRecognizer } from "./continuous";

export type ServerSpawn = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

/** F2: Confidence thresholds for whisper verbose_json. */
export const NO_SPEECH_PROB_THRESHOLD = 0.5;
export const AVG_LOGPROB_THRESHOLD = -0.8;

/** F2: Parsed verbose_json segment fields we care about. */
export interface WhisperSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

export interface WhisperVerboseJson {
  text: string;
  segments?: WhisperSegment[];
}

/**
 * F2: Check if verbose_json segments pass confidence thresholds.
 *
 * NOTE: no_speech_prob is NOT used for gating. whisper-server (whisper.cpp
 * 1.9.x) reports a stale/garbage value: POSTing the same clip three times in a
 * row returned 0.001, 0.169 and 0.931, and real commands ("smart mouse",
 * "minimize chrome") were rejected at ~0.9 while silence scored 0.001. It is
 * kept in the log line for diagnostics only. avg_logprob behaves sanely
 * (real speech −0.04…−0.37) so it remains a (loose) gate.
 */
export function checkVerboseJsonConfidence(parsed: WhisperVerboseJson): { ok: boolean; reason?: string } {
  const segments = parsed.segments ?? [];
  for (const seg of segments) {
    if (seg.avg_logprob !== undefined && seg.avg_logprob < AVG_LOGPROB_THRESHOLD) {
      return { ok: false, reason: `avg_logprob=${seg.avg_logprob.toFixed(3)} < ${AVG_LOGPROB_THRESHOLD}` };
    }
  }
  return { ok: true };
}

/** Words of a transcript, lower-cased, punctuation stripped. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

/** True when whisper produced a non-speech marker like "[BLANK_AUDIO]" or "(silence)". */
export function isNonSpeechTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const stripped = t.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, "").replace(/[\s.,!?♪-]+/g, "");
  return stripped.length === 0;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Prompt-bias check for short transcripts. The command-phrase prompt makes
 * whisper turn room noise into a command word ("click"); without the prompt the
 * same clip comes back as "[BLANK_AUDIO]". Accept the prompted transcript only
 * if the unprompted one is real speech that shares at least one word with it.
 */
export function unpromptedAgrees(prompted: string, unprompted: string): boolean {
  if (isNonSpeechTranscript(unprompted)) return false;
  const a = words(prompted);
  const b = words(unprompted);
  if (!a.length || !b.length) return false;
  return a.some((wa) => b.some((wb) => wa === wb || (Math.min(wa.length, wb.length) >= 4 && editDistance(wa, wb) <= 2)));
}

/** Transcripts with at most this many words get the unprompted re-check. */
export const UNPROMPTED_CHECK_MAX_WORDS = 2;

const defaultSpawn: ServerSpawn = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });

export interface WhisperServerRecognizerOptions {
  /**
   * Prompt-bias guard hook: "is the plain (unprompted) transcription something intent recovery
   * can work with?" (`RecoveryEngine.canRecover`). Default: never.
   */
  recoverable?: (plain: string, alternatives?: string[]) => boolean;
  /** whisper-server executable. */
  command: string;
  /** ggml model path. */
  model: string;
  host?: string;
  /** Port; 0/undefined picks a free localhost port. */
  port?: number;
  /** Extra server args (e.g. ["-t", "8"]). */
  args?: string[];
  /** Static STT prompt (combined with dynamic command phrases). */
  prompt?: string;
  spawn?: ServerSpawn;
  fetch?: typeof fetch;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Readiness poll interval (ms). */
  pollMs?: number;
  /**
   * F2: Use verbose_json to get confidence metrics (no_speech_prob, avg_logprob).
   * Segments failing thresholds are silently rejected.
   */
  verboseJson?: boolean;
}

/** Ask the OS for a free TCP port on `host`. */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a port"))));
    });
  });
}

function combinePrompt(staticPrompt: string | undefined, phrases: string[]): string | undefined {
  const parts: string[] = [];
  if (staticPrompt?.trim()) parts.push(staticPrompt.trim());
  // F3: Only include phrases ≥ 2 words — short single-word verbs bias Whisper to hallucinate them.
  const multiWord = phrases.filter((p) => p.trim().split(/\s+/).length >= 2);
  if (multiWord.length) parts.push(multiWord.slice(0, 30).join(". ") + ".");
  return parts.length ? parts.join(" ") : undefined;
}

export class WhisperServerRecognizer implements UtteranceRecognizer {
  readonly label = "whisper-server";
  private child?: ChildProcessWithoutNullStreams;
  private baseUrl = "";
  private stderrTail = "";
  private exited = false;
  private promptPhrases: string[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly onProcessExit = () => this.kill();

  constructor(private readonly options: WhisperServerRecognizerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  isRunning(): boolean {
    return !!this.child && !this.exited;
  }

  /** Spawn the server and wait until it answers HTTP. Throws on failure. */
  async start(): Promise<void> {
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port || (await findFreePort(host));
    this.baseUrl = `http://${host}:${port}`;
    const args = [
      "-m", this.options.model,
      "--host", host,
      "--port", String(port),
      "-nt",
      ...(this.options.args ?? []),
    ];
    const child = (this.options.spawn ?? defaultSpawn)(this.options.command, args);
    this.child = child;
    this.exited = false;
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; this.exited = true; });
    child.once("exit", () => { this.exited = true; });
    // Always drain pipes so a chatty server can never block on a full pipe.
    child.stdout?.on("data", () => undefined);
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });
    process.once("exit", this.onProcessExit);

    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 20_000);
    const pollMs = this.options.pollMs ?? 50;
    while (Date.now() < deadline) {
      if (spawnError) {
        this.kill();
        throw new Error(`whisper-server failed to start: ${spawnError.message}`);
      }
      if (this.exited) {
        this.kill();
        throw new Error(`whisper-server exited during startup: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ") || "no output"}`);
      }
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/`, { signal: AbortSignal.timeout(500) });
        if (res.status < 500) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.kill();
    throw new Error("whisper-server did not become ready before the startup timeout");
  }

  setPromptPhrases(phrases: string[]): void {
    this.promptPhrases = phrases;
  }

  async recognize(wav: Buffer, signal: AbortSignal): Promise<string> {
    if (!this.isRunning()) throw new Error("whisper-server is not running");
    const prompt = combinePrompt(this.options.prompt, this.promptPhrases);
    const text = await this.infer(wav, signal, prompt);
    // Prompt-bias guard: short prompted results must survive an unprompted pass.
    if (prompt && text && !isNonSpeechTranscript(text) && words(text).length <= UNPROMPTED_CHECK_MAX_WORDS) {
      const plain = await this.infer(wav, signal, undefined, true);
      if (!unpromptedAgrees(text, plain)) {
        // The prompt can swallow half of a made-up word (prompted "kubectl."
        // vs unprompted "cube control get"). If a recoverer can work with the unprompted pass,
        // hand that on so intent recovery can use it.
        if (plain.trim() && this.options.recoverable?.(plain, [text])) {
          console.log(`[voice] prompt bias: "${text}" vs unprompted "${plain.trim()}" — using unprompted`);
          return plain.trim();
        }
        console.log(`[voice] rejected (prompt bias): "${text}" but unprompted heard "${plain.trim() || "(nothing)"}"`);
        return "";
      }
    }
    return isNonSpeechTranscript(text) ? "" : text;
  }

  private async infer(wav: Buffer, signal: AbortSignal, prompt: string | undefined, quiet = false): Promise<string> {
    const useVerbose = this.options.verboseJson ?? false;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
    form.append("response_format", useVerbose ? "verbose_json" : "text");
    form.append("temperature", "0.0");
    if (prompt) form.append("prompt", prompt);
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000);
    const res = await this.fetchImpl(`${this.baseUrl}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal,
    });
    if (!res.ok) {
      throw new Error(`whisper-server /inference returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.text();
    // verbose_json: check confidence thresholds (F2), degrade gracefully if fields absent.
    try {
      // whisper-server emits raw newlines inside the JSON "text" string.
      const parsed = JSON.parse(body.replace(/\n/g, " "));
      if (useVerbose && parsed && typeof parsed.text === "string" && Array.isArray(parsed.segments)) {
        const check = checkVerboseJsonConfidence(parsed as WhisperVerboseJson);
        if (!check.ok) {
          if (!quiet) console.log(`[voice] rejected (whisper confidence): ${check.reason} — "${parsed.text.trim()}"`);
          return "";
        }
        return parsed.text.trim();
      }
      if (parsed && typeof parsed.text === "string") return parsed.text.trim();
      if (parsed && typeof parsed.error === "string") throw new Error(`whisper-server error: ${parsed.error}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("whisper-server error")) throw error;
    }
    return body.trim();
  }

  private kill(): void {
    process.removeListener("exit", this.onProcessExit);
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.child = undefined;
  }

  async close(): Promise<void> {
    this.kill();
  }
}

/**
 * Uses `primary` until it fails once (not counting aborts), then permanently
 * switches to `fallback` for this and all later utterances.
 */
export class FallbackRecognizer implements UtteranceRecognizer {
  private failed = false;

  constructor(
    private readonly primary: UtteranceRecognizer,
    private readonly fallback: UtteranceRecognizer,
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  get label(): string | undefined {
    return this.failed ? this.fallback.label : this.primary.label;
  }

  usingFallback(): boolean {
    return this.failed;
  }

  setPromptPhrases(phrases: string[]): void {
    this.primary.setPromptPhrases?.(phrases);
    this.fallback.setPromptPhrases?.(phrases);
  }

  async recognize(wav: Buffer, signal: AbortSignal): Promise<string> {
    if (!this.failed) {
      try {
        return await this.primary.recognize(wav, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        this.failed = true;
        this.onFallback?.(error);
        await this.primary.close?.().catch(() => undefined);
      }
    }
    return this.fallback.recognize(wav, signal);
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close?.(), this.fallback.close?.()]);
  }
}

export type SttBackend = "cli" | "server";

export function parseSttBackend(value: string | undefined, serverAvailable: boolean): SttBackend {
  if (value === undefined || value === "") return serverAvailable ? "server" : "cli";
  if (value === "cli" || value === "server") return value;
  throw new Error(`--stt-backend must be "cli" or "server" (got "${value}")`);
}

/** Derive the whisper-server path that sits next to a whisper-cli binary. */
export function siblingWhisperServer(cliCommand: string, exists: (path: string) => boolean): string | undefined {
  if (!basename(cliCommand).includes("whisper-cli")) return undefined;
  const candidate = cliCommand.replace(/whisper-cli(?=[^/]*$)/, "whisper-server");
  return exists(candidate) ? candidate : undefined;
}


export interface CreateWhisperRecognizerOptions {
  /** whisper-cli (or other local recognizer) command. */
  cliCommand: string;
  /** whisper.cpp model; required for the server backend. */
  model?: string;
  /** CLI args for the per-utterance recognizer. */
  cliArgs: string[];
  prompt?: string;
  /** "cli" | "server" | undefined (auto: server when installed). */
  backend?: string;
  /** Explicit whisper-server path (otherwise discovered). */
  serverCommand?: string;
  /** F2: Enable verbose_json for confidence gating. Default false. */
  verboseJson?: boolean;
  /** Prompt-bias guard hook, see WhisperServerRecognizerOptions.recoverable. */
  recoverable?: (plain: string, alternatives?: string[]) => boolean;
  exists?: (path: string) => boolean;
  log?: (message: string) => void;
  /** Test seams. */
  createCli?: (command: string, args: string[]) => UtteranceRecognizer;
  createServer?: (options: WhisperServerRecognizerOptions) => WhisperServerRecognizer;
}

const WHISPER_SERVER_CANDIDATES = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"];

/**
 * Build the local recognizer: a persistent whisper-server (default when
 * installed) with automatic fallback to per-utterance whisper-cli.
 */
export async function createWhisperRecognizer(
  options: CreateWhisperRecognizerOptions,
): Promise<UtteranceRecognizer> {
  const exists = options.exists ?? existsSync;
  const log = options.log ?? (() => undefined);
  const cli = options.createCli
    ? options.createCli(options.cliCommand, options.cliArgs)
    : new CommandUtteranceRecognizer({ command: options.cliCommand, args: options.cliArgs });
  const isWhisper = basename(options.cliCommand).includes("whisper");
  const serverCommand = options.serverCommand ??
    (isWhisper ? siblingWhisperServer(options.cliCommand, exists) ?? WHISPER_SERVER_CANDIDATES.find(exists) : undefined);
  const backend = parseSttBackend(options.backend, !!serverCommand && !!options.model);
  if (backend === "cli") return cli;
  if (!serverCommand || !options.model) {
    log(`whisper-server not available${options.model ? "" : " (no model)"}; using ${cli.label ?? options.cliCommand}`);
    return cli;
  }
  const serverOptions: WhisperServerRecognizerOptions = {
    command: serverCommand,
    model: options.model,
    prompt: options.prompt,
    verboseJson: options.verboseJson,
    recoverable: options.recoverable,
  };
  const server = options.createServer ? options.createServer(serverOptions) : new WhisperServerRecognizer(serverOptions);
  const startedAt = Date.now();
  try {
    await server.start();
  } catch (error) {
    log(`whisper-server failed to start (${error instanceof Error ? error.message : String(error)}); falling back to ${cli.label ?? options.cliCommand}`);
    await server.close().catch(() => undefined);
    return cli;
  }
  log(`whisper-server ready at ${server.url} in ${Date.now() - startedAt}ms (model stays loaded)`);
  return new FallbackRecognizer(server, cli, (error) =>
    log(`whisper-server request failed (${error instanceof Error ? error.message : String(error)}); falling back to ${cli.label ?? options.cliCommand}`)
  );
}
