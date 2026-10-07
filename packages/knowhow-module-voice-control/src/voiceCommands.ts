/**
 * Voice command registry.
 *
 * Voice commands are contributed three ways:
 *   1. Module extensions of type "voice-control.command" (`VOICE_COMMAND_EXTENSION`)
 *      on any loaded knowhow module's `extensions` array. The built-ins below
 *      are registered exactly this way by this module.
 *   2. `.knowhow/knowhow.json` → `voiceControl.commands` (shell / automation).
 *   3. Live automation phrases registered with the eye-tracking hub
 *      (`sdk.ext.voice.onCommand`) — these are "dynamic" and are not part of
 *      this static registry (they're fetched from the hub at runtime).
 */

import { spawn as nodeSpawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { GazeSample } from "./eyeTracking";
import type { MouseMover } from "./commandMode";
import { clickTarget, clickThat, doubleClickTarget } from "./pointerMemory";

export const VOICE_COMMAND_EXTENSION = "voice-control.command" as const;

export type VoiceCommandMode = "command" | "agent";

export interface VoiceCommandContext {
  /** Canonical phrase that matched. */
  phrase: string;
  /** Full recognized text. */
  text: string;
  /** Epoch ms of speech onset (VAD). */
  spokenAt: number;
  /** Epoch ms STT finished. */
  recognizedAt: number;
  /** Gaze sample nearest speech onset (if the eye tracker is running). */
  gaze?: GazeSample;
  /** The session's mouse mover (computer-use), when available. */
  mouse?: MouseMover;
  /** Gaze-follow controller (eye-controlled mouse), when available. */
  gazeFollow?: {
    start(): void;
    stop(): void;
    isRunning(): boolean;
    currentPosition(): { x: number; y: number } | undefined;
  };
  /** Best target point: gaze-follow position if running, else gaze at onset. */
  target(): { x: number; y: number } | undefined;
  setMode(mode: VoiceCommandMode): void;
  log(msg: string): void;
  /** Slot values from grammar pattern match. */
  slots: Record<string, unknown>;
  /** Repeat count (trailing number or "again N times"). Default 1. */
  repeat: number;
  /** Platform actions (keys, text, windows). Available when a platform adapter is loaded. */
  actions?: import("./actions/types").PlatformActions;
  /** Last executed plan, for "repeat"/"undo that". */
  /** Mutable history array — push undo records here for "undo that". */
  history?: unknown[];
}

export interface VoiceCommandExtension {
  type: typeof VOICE_COMMAND_EXTENSION;
  /** Unique id, e.g. "computer-use.click". Used for dedupe. */
  name: string;
  /** Canonical phrase, e.g. "click". */
  phrase: string;
  /** Grammar pattern (optional). Plain phrase still works. */
  pattern?: string;
  /** Multiple patterns for this command. */
  patterns?: string[];
  /** Whether trailing number is a repeat count (ctx.repeat). */
  repeatable?: boolean;
  /** Risk level: "low" (default) or "confirm" (shows overlay, waits for "confirm"). */
  risk?: "low" | "confirm";
  /** Minimum voiced audio duration to accept this command (ms). Default 250. */
  minVoicedMs?: number;
  /** Maximum audio clip length for this command (ms). Single-word commands default ~2500. */
  maxAudioMs?: number;
  /** Platforms this command runs on. Undefined = all platforms. */
  platforms?: NodeJS.Platform[];
  /** Context filter: command only wins over global when app matches. */
  context?: { app?: string | string[] };
  aliases?: string[];
  /** Shown in `knowhow voice-control commands`. */
  description: string;
  /** Default ["command"]. "agent" means it also fires in agent mode. */
  modes?: VoiceCommandMode[];
  /** Runs inside the voice-agent process. */
  run(ctx: VoiceCommandContext): void | Promise<void>;
  /** Set by ExtensionsService.register — the owning module path. */
  owner?: string;
  [key: string]: unknown;
}

/** A command in the resolved registry, with its provenance. */
export interface RegisteredVoiceCommand extends VoiceCommandExtension {
  /** "built-in", a module name/path, or "knowhow.json". */
  source: string;
}

// ─── Built-ins ────────────────────────────────────────────────────────────────

function cmd(
  name: string,
  phrase: string,
  aliases: string[],
  description: string,
  run: VoiceCommandExtension["run"],
  modes: VoiceCommandMode[] = ["command"],
): VoiceCommandExtension {
  return { type: VOICE_COMMAND_EXTENSION, name, phrase, aliases, description, modes, run };
}

export const BUILTIN_VOICE_COMMANDS: VoiceCommandExtension[] = [
  cmd(
    "voice-control.eye-control-mouse",
    "eye control mouse",
    ["gaze mouse", "follow my eyes", "eyecontrol mouse", "i control mouse", "eye control"],
    "Start moving the mouse pointer with your gaze",
    (ctx) => { ctx.gazeFollow?.start(); },
  ),
  cmd(
    "voice-control.stop-mouse",
    "stop mouse",
    ["stop eye control", "stop gaze", "stop following"],
    "Stop gaze-controlled mouse movement",
    (ctx) => { ctx.gazeFollow?.stop(); },
  ),
  // Plain clicks act on the pointer a hint just placed ("mouse over theo" →
  // "click"), else where you're looking. "click" is a short plosive word: real
  // ones measured 100–240ms voiced, so the floor is 100ms (the whisper
  // prompt-bias re-check filters noise that turns into "click").
  {
    // "click that" / "click it" click whatever is under the pointer *now*
    // (e.g. after "mouse over drive"); they never re-target to the gaze point.
    ...cmd("voice-control.click-that", "click that", ["click it", "click this", "click that one"], "Left-click whatever is under the pointer right now (no gaze re-targeting)", async (ctx) => {
      await clickThat(ctx, "left");
    }),
    minVoicedMs: 100,
  },
  {
    ...cmd("voice-control.click", "click", ["click here", "click there", "click click", "clique"], "Left-click the pointer a hint just placed, else where you are looking", async (ctx) => {
      const pos = clickTarget(ctx);
      if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "left");
    }),
    minVoicedMs: 100,
  },
  {
    ...cmd("voice-control.double-click", "double click", ["doubleclick"], "Double-click the hinted pointer, else where you are looking", async (ctx) => {
      const pos = doubleClickTarget(ctx);
      if (pos && ctx.mouse) await ctx.mouse.doubleClickAt(pos.x, pos.y);
    }),
    minVoicedMs: 150,
  },
  {
    ...cmd("voice-control.right-click", "right click", ["rightclick"], "Right-click the hinted pointer, else where you are looking", async (ctx) => {
      const pos = clickTarget(ctx);
      if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "right");
    }),
    minVoicedMs: 150,
  },
  cmd(
    "voice-control.agent-mode",
    "agent mode",
    [],
    "Switch to agent mode (utterances go to the agent)",
    (ctx) => ctx.setMode("agent"),
    ["command", "agent"],
  ),
  cmd(
    "voice-control.command-mode",
    "command mode",
    [],
    "Switch to command mode (utterances are matched against commands)",
    (ctx) => ctx.setMode("command"),
    ["command", "agent"],
  ),
];

const BUILTIN_NAMES = new Set(BUILTIN_VOICE_COMMANDS.map((c) => c.name));

export function isVoiceCommandExtension(value: unknown): value is VoiceCommandExtension {
  const v = value as VoiceCommandExtension;
  return !!v && v.type === VOICE_COMMAND_EXTENSION &&
    typeof v.name === "string" && !!v.name &&
    typeof v.phrase === "string" && !!v.phrase.trim() &&
    typeof v.run === "function";
}

export function commandModes(command: Pick<VoiceCommandExtension, "modes">): VoiceCommandMode[] {
  return command.modes?.length ? command.modes : ["command"];
}

// ─── knowhow.json commands ───────────────────────────────────────────────────

export interface ConfigVoiceCommand {
  phrase: string;
  aliases?: string[];
  description?: string;
  /** Shell command; env KNOWHOW_GAZE_X/Y and KNOWHOW_PHRASE are set. */
  shell?: string;
  /** Automation name, run via `knowhow computer run-automation <name>` (detached). */
  automation?: string;
  modes?: VoiceCommandMode[];
}

export type DetachedSpawn = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => void;

const defaultDetachedSpawn: DetachedSpawn = (command, args, env) => {
  const child = nodeSpawn(command, args, { detached: true, stdio: "ignore", env });
  child.on("error", () => undefined);
  child.unref();
};

const AUTOMATION_NAME = /^[\w.\-/]+$/;

/**
 * Convert `voiceControl.commands` entries from knowhow.json to command extensions.
 * Invalid entries are skipped (reported through `warn`).
 */
export function loadConfigVoiceCommands(
  config: unknown,
  options: { spawn?: DetachedSpawn; warn?: (msg: string) => void; knowhowBin?: string } = {},
): VoiceCommandExtension[] {
  const spawnDetached = options.spawn ?? defaultDetachedSpawn;
  const warn = options.warn ?? (() => undefined);
  const entries = (config as any)?.voiceControl?.commands;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    warn("voiceControl.commands must be an array; ignoring");
    return [];
  }
  const out: VoiceCommandExtension[] = [];
  entries.forEach((raw: ConfigVoiceCommand, index: number) => {
    if (!raw || typeof raw.phrase !== "string" || !raw.phrase.trim()) {
      warn(`voiceControl.commands[${index}] needs a non-empty "phrase"; skipping`);
      return;
    }
    const hasShell = typeof raw.shell === "string" && raw.shell.trim().length > 0;
    const hasAutomation = typeof raw.automation === "string" && raw.automation.trim().length > 0;
    if (hasShell === hasAutomation) {
      warn(`voiceControl.commands[${index}] ("${raw.phrase}") needs exactly one of "shell" or "automation"; skipping`);
      return;
    }
    if (hasAutomation && !AUTOMATION_NAME.test(raw.automation!)) {
      warn(`voiceControl.commands[${index}] has an invalid automation name; skipping`);
      return;
    }
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === "string") : [];
    const modes = Array.isArray(raw.modes)
      ? raw.modes.filter((m): m is VoiceCommandMode => m === "command" || m === "agent")
      : undefined;
    const description = typeof raw.description === "string" && raw.description
      ? raw.description
      : hasShell ? `shell: ${raw.shell}` : `automation: ${raw.automation}`;
    out.push({
      type: VOICE_COMMAND_EXTENSION,
      name: `knowhow.json.${index}.${raw.phrase.trim()}`,
      phrase: raw.phrase.trim(),
      aliases,
      description,
      modes: modes?.length ? modes : undefined,
      run(ctx) {
        const target = ctx.target();
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          KNOWHOW_PHRASE: ctx.phrase,
          KNOWHOW_TEXT: ctx.text,
          KNOWHOW_SPOKEN_AT: String(ctx.spokenAt),
          ...(target ? { KNOWHOW_GAZE_X: String(target.x), KNOWHOW_GAZE_Y: String(target.y) } : {}),
        };
        if (hasShell) {
          ctx.log(`running shell for "${ctx.phrase}"`);
          spawnDetached("/bin/sh", ["-c", raw.shell!], env);
        } else {
          ctx.log(`running automation ${raw.automation} for "${ctx.phrase}"`);
          spawnDetached(options.knowhowBin ?? "knowhow", ["computer", "run-automation", raw.automation!], env);
        }
      },
    });
  });
  return out;
}

/** Read `.knowhow/knowhow.json` via core's config loader, falling back to the file. */
export function readKnowhowConfig(cwd = process.cwd()): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConfigSync } = require("@tyvm/knowhow/ts_build/src/config");
    if (typeof getConfigSync === "function" && cwd === process.cwd()) return getConfigSync();
  } catch {
    // fall through
  }
  const file = join(cwd, ".knowhow", "knowhow.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// ─── Registry collection ─────────────────────────────────────────────────────

export interface ExtensionsLike {
  list(type: string): readonly unknown[];
}

export interface CollectVoiceCommandsOptions {
  /** ExtensionsService (all loaded modules). */
  extensions?: ExtensionsLike | null;
  /** Additional extension objects (e.g. read directly from module exports). */
  moduleExtensions?: Array<{ owner: string; extension: unknown }>;
  /** knowhow.json config object (for voiceControl.commands). */
  config?: unknown;
  /** Built-ins (default BUILTIN_VOICE_COMMANDS). */
  builtins?: VoiceCommandExtension[];
  spawn?: DetachedSpawn;
  warn?: (msg: string) => void;
}

/**
 * Collect all registered voice commands, deduped by `name` (first wins).
 * Order (= match priority): knowhow.json, module extensions, built-ins.
 */
export function collectVoiceCommands(options: CollectVoiceCommandsOptions = {}): RegisteredVoiceCommand[] {
  const out: RegisteredVoiceCommand[] = [];
  const seen = new Set<string>();
  const add = (ext: VoiceCommandExtension, source: string) => {
    if (seen.has(ext.name)) return;
    seen.add(ext.name);
    out.push({ ...ext, source });
  };
  const sourceFor = (ext: VoiceCommandExtension, owner?: string) =>
    BUILTIN_NAMES.has(ext.name) ? "built-in" : (owner || ext.owner || "module");

  for (const ext of loadConfigVoiceCommands(options.config, { spawn: options.spawn, warn: options.warn })) {
    add(ext, "knowhow.json");
  }
  for (const item of options.extensions?.list(VOICE_COMMAND_EXTENSION) ?? []) {
    if (isVoiceCommandExtension(item)) add(item, sourceFor(item));
    else options.warn?.(`ignoring invalid ${VOICE_COMMAND_EXTENSION} extension`);
  }
  for (const { owner, extension } of options.moduleExtensions ?? []) {
    if ((extension as any)?.type !== VOICE_COMMAND_EXTENSION) continue;
    if (isVoiceCommandExtension(extension)) add(extension, sourceFor(extension, owner));
  }
  for (const ext of options.builtins ?? BUILTIN_VOICE_COMMANDS) add(ext, "built-in");
  return out;
}

// ─── CLI table ───────────────────────────────────────────────────────────────

export interface VoiceCommandRow {
  phrase: string;
  aliases: string[];
  modes: VoiceCommandMode[];
  source: string;
  description: string;
}

export function commandRows(
  registered: ReadonlyArray<RegisteredVoiceCommand>,
  live: ReadonlyArray<{ phrase: string; aliases?: string[]; description?: string }> = [],
): VoiceCommandRow[] {
  return [
    ...live.map((s) => ({
      phrase: s.phrase,
      aliases: s.aliases ?? [],
      modes: ["command"] as VoiceCommandMode[],
      source: "automation (live from hub)",
      description: s.description ?? "",
    })),
    ...registered.map((c) => ({
      phrase: c.phrase,
      aliases: c.aliases ?? [],
      modes: commandModes(c),
      source: c.source,
      description: c.description ?? "",
    })),
  ];
}

/** Render rows as a fixed-width text table. Pure. */
export function formatVoiceCommandsTable(rows: ReadonlyArray<VoiceCommandRow>): string {
  const headers = ["PHRASE", "ALIASES", "MODES", "SOURCE", "DESCRIPTION"];
  const cells = rows.map((r) => [
    r.phrase,
    r.aliases.join(", ") || "-",
    r.modes.join(","),
    r.source,
    r.description || "-",
  ]);
  const widths = headers.map((h, i) =>
    Math.min(i === 4 ? 1000 : 40, Math.max(h.length, ...cells.map((c) => c[i].length))),
  );
  const fit = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s.padEnd(w));
  const line = (c: string[]) => c.map((s, i) => (i === c.length - 1 ? s : fit(s, widths[i]))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n") + "\n";
}
