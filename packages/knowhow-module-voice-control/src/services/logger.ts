/**
 * One tagged, levelled logger for voice-control. Replaces the console.log /
 * ctx.log / options.log mix: `log.child("hints").info("map on")` prints
 * `[hints] map on`.
 */

import { ConfigResolver, LOG_SERVICE_CONFIG, getDefaultConfig } from "../config";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface VoiceLogger {
  readonly tag: string;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Same sink and level, different tag. */
  child(tag: string): VoiceLogger;
}

export type LogSink = (level: Exclude<LogLevel, "silent">, line: string, tag: string, msg: string) => void;

const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/** Sink for processes whose stdout carries data (JSON lines): everything goes to stderr. */
export const stderrSink: LogSink = (_level, line) => void process.stderr.write(line + "\n");

/**
 * Log-line formatting policy: at most `max` items (default 60) then "… +N more". Lives here so every
 * caller that dumps a long list (hint labels, commands) trims the same way.
 */
export function formatList(items: readonly string[], max = 60): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, … +${items.length - max} more` : shown;
}

const taggedLoggers = new Map<string, VoiceLogger>();
/**
 * A process-wide tagged logger for code that has no `services` handle (the eye tracker, AX helper, whisper
 * server): `taggedLogger("eye").info("…")` prints `[eye] …`. Same levels and `KNOWHOW_VOICE_LOG_LEVEL`.
 */
export function taggedLogger(tag: string, sink?: LogSink): VoiceLogger {
  const key = `${tag}\u0000${sink ? "custom" : "console"}`;
  let l = sink ? undefined : taggedLoggers.get(key);
  if (!l) {
    l = createVoiceLogger({ tag, sink });
    if (!sink) taggedLoggers.set(key, l);
  }
  return l;
}

export function resolveLogLevel(source?: NodeJS.ProcessEnv | ConfigResolver): LogLevel {
  const config =
    source instanceof ConfigResolver
      ? source
      : source
        ? new ConfigResolver({ env: () => source, json: () => ({}) })
        : getDefaultConfig();
  return config.get({ kind: "services", name: "log" }, "level", LOG_SERVICE_CONFIG.level);
}

export function createVoiceLogger(
  opts: { tag?: string; level?: LogLevel; sink?: LogSink } = {},
): VoiceLogger {
  const tag = opts.tag ?? "voice";
  const level = opts.level ?? resolveLogLevel();
  const sink = opts.sink ?? consoleSink;
  const emit = (lvl: Exclude<LogLevel, "silent">, msg: string) => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(lvl, `[${tag}] ${msg}`, tag, msg);
  };
  return {
    tag,
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    child: (childTag) => createVoiceLogger({ tag: childTag, level, sink }),
  };
}

/** A logger that records instead of printing (tests). */
export function createMemoryLogger(level: LogLevel = "debug"): VoiceLogger & { lines: string[] } {
  const lines: string[] = [];
  const base = createVoiceLogger({ level, sink: (_l, line) => void lines.push(line) });
  return Object.assign(base, { lines });
}
