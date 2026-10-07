import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "child_process";
import { throwIfAborted } from "./eventQueue";
import { ContinuousAudioBackend, PcmFrame } from "./types";

export type ContinuousSpawn = (
  command: string,
  args: readonly string[]
) => ChildProcessWithoutNullStreams;

export const defaultSpawn: ContinuousSpawn = (command, args) =>
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
