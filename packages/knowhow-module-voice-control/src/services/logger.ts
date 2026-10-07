/**
 * One tagged, levelled logger for voice-control. Replaces the console.log /
 * ctx.log / options.log mix: `log.child("hints").info("map on")` prints
 * `[hints] map on`.
 */

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

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.KNOWHOW_VOICE_LOG_LEVEL ?? "").toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "info";
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
