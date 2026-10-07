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
import { getConfigSync } from "@tyvm/knowhow/sdk";
import type { GazeSample } from "./eyeTracking";
import type { MouseMover } from "./commandMode";
import { defineVoicePack } from "./packs/define";
import { aliasesWithSynonyms, defineCommand, VOICE_COMMAND_EXTENSION } from "./commands/define";
import { analyzeCommands, applyOverrides } from "./commands/registry";
import { runDoubleClick } from "./commands/doubleClick";
import { performClick } from "./targeting/act";
import type { CommandConflict } from "./commands/registry";
import { mergeSynonyms } from "./grammar/compile";

export { VOICE_COMMAND_EXTENSION };

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
  /** Session services (platform, gaze, pointer, pending, clock, logger…). Always set by pack commands. */
  services?: import("./services").VoiceServices;
  /** The owning pack's per-session state (set for commands defined with `defineVoicePack`). */
  state?: unknown;
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
  /**
   * Extra literal phrases. Literal `patterns` are added automatically by
   * `defineCommand`, so only list phrases that are NOT in `patterns`.
   */
  aliases?: string[];
  /**
   * Vocabulary layer: `{ hints: ["map"] }` makes "map" accepted wherever this
   * command's patterns say "hints" (expanded when patterns are compiled).
   * Merged with `knowhow.json → voiceControl.synonyms` by collectVoiceCommands.
   */
  synonyms?: Record<string, string[]>;
  /**
   * Name of another command this one intentionally replaces. The overridden
   * command is dropped from the registry (and no conflict is reported).
   */
  overrides?: string;
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

const command = defineCommand;

/** The core click / mouse / mode commands (no prefix: names are `voice-control.<name>`). */
export const BUILTIN_PACK = defineVoicePack({
  name: "built-in",
  description: "Gaze mouse, click / double click / right click, agent and command mode",
  commands: ({ command }) => [
  command({
    name: "voice-control.eye-control-mouse",
    phrase: "eye control mouse",
    aliases: ["gaze mouse", "follow my eyes", "eyecontrol mouse", "i control mouse", "eye control", "eye mouse", "i mouse"],
    description: "Start moving the mouse pointer with your gaze",
    run: (ctx) => {
      ctx.gazeFollow?.start();
      ctx.services.log.info("gaze mouse ON");
    },
  }),
  command({
    name: "voice-control.stop-mouse",
    phrase: "stop mouse",
    aliases: ["stop eye control", "stop gaze", "stop following", "mouse off", "freeze"],
    description: "Stop gaze-controlled mouse movement",
    run: (ctx) => {
      ctx.gazeFollow?.stop();
      // The hints pack owns the smart mouse; reach it through its state, not its module.
      ctx.services.packs.peek<{ stopSmartMouse(): void }>("hints")?.stopSmartMouse();
      ctx.services.log.info("gaze mouse OFF");
    },
  }),
  // Plain clicks act on the pointer a hint just placed ("mouse over theo" →
  // "click"), else where you're looking. "click" is a short plosive word: real
  // ones measured 100–240ms voiced, so the floor is 100ms (the whisper
  // prompt-bias re-check filters noise that turns into "click").
  command({
    name: "voice-control.click-that",
    phrase: "click that",
    aliases: ["click it", "click this", "click that one"],
    description: "Left-click whatever is under the pointer right now (no gaze re-targeting)",
    run: async (ctx) => {
      await performClick(ctx, "click", { that: true });
    },
    minVoicedMs: 100,
  }),
  command({
    name: "voice-control.click",
    phrase: "click",
    aliases: ["click here", "click there", "click click", "clique"],
    description: "Left-click the pointer a hint just placed, else where you are looking",
    run: async (ctx) => {
      await performClick(ctx, "click");
    },
    minVoicedMs: 100,
  }),
  command({
    name: "voice-control.double-click",
    phrase: "double click",
    aliases: [
      "doubleclick",
      "double click that",
      "double click it",
      "double click here",
      "double click there",
      "double-click that",
      "double-click it",
      "double-click here",
    ],
    description:
      "Double-click the hinted pointer, else where you are looking. 'double click that/it/here' first acts on the element a 'mouse over' just hovered (the front app's adapter decides: e.g. plays a track row, presses a button)",
    run: runDoubleClick,
    minVoicedMs: 150,
  }),
  command({
    name: "voice-control.right-click",
    phrase: "right click",
    aliases: ["rightclick"],
    description: "Right-click the hinted pointer, else where you are looking",
    run: async (ctx) => {
      await performClick(ctx, "rightClick");
    },
    minVoicedMs: 150,
  }),
  command({
    name: "voice-control.agent-mode",
    phrase: "agent mode",
    description: "Switch to agent mode (utterances go to the agent)",
    run: (ctx) => ctx.setMode("agent"),
    modes: ["command", "agent"],
  }),
  command({
    name: "voice-control.command-mode",
    phrase: "command mode",
    description: "Switch to command mode (utterances are matched against commands)",
    run: (ctx) => ctx.setMode("command"),
    modes: ["command", "agent"],
  }),
  ],
});

export const BUILTIN_VOICE_COMMANDS: VoiceCommandExtension[] = BUILTIN_PACK.extensions;

const BUILTIN_NAMES = new Set(BUILTIN_VOICE_COMMANDS.map((c) => c.name));

export function isVoiceCommandExtension(value: unknown): value is VoiceCommandExtension {
  const v = value as VoiceCommandExtension;
  return (
    !!v &&
    v.type === VOICE_COMMAND_EXTENSION &&
    typeof v.name === "string" &&
    !!v.name &&
    typeof v.phrase === "string" &&
    !!v.phrase.trim() &&
    typeof v.run === "function"
  );
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

export type DetachedSpawn = (command: string, args: string[], env: NodeJS.ProcessEnv) => void;

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
  options: { spawn?: DetachedSpawn; warn?: (msg: string) => void; knowhowBin?: string } = {}
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
    const description =
      typeof raw.description === "string" && raw.description
        ? raw.description
        : hasShell
        ? `shell: ${raw.shell}`
        : `automation: ${raw.automation}`;
    out.push(
      command({
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
      })
    );
  });
  return out;
}

/** Read `.knowhow/knowhow.json` via core's config loader, falling back to the file. */
export function readKnowhowConfig(cwd = process.cwd()): unknown {
  try {
    if (cwd === process.cwd()) return getConfigSync();
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

/** The resolved registry plus everything the validator found wrong with it. */
export interface VoiceCommandReport {
  commands: RegisteredVoiceCommand[];
  conflicts: CommandConflict[];
  /** Names dropped because another command declared `overrides` for them. */
  overridden: string[];
}

/**
 * Collect all registered voice commands, deduped by `name` (first wins), with
 * `overrides` applied, config synonyms merged in and the registry validated.
 * Order (= match priority): knowhow.json, module extensions, built-ins.
 */
export function collectVoiceCommandReport(options: CollectVoiceCommandsOptions = {}): VoiceCommandReport {
  const collected: RegisteredVoiceCommand[] = [];
  const seen = new Map<string, VoiceCommandExtension>();
  const duplicateNames: string[] = [];
  const configSynonyms = readConfigSynonyms(options.config);
  const add = (ext: VoiceCommandExtension, source: string) => {
    const first = seen.get(ext.name);
    if (first) {
      // The very same command arriving twice (ExtensionsService + built-in fallback) is not a conflict;
      // `overrides: <its own name>` marks an intentional same-name replacement.
      const same = first.run === ext.run;
      if (!same && ext.overrides !== ext.name && !duplicateNames.includes(ext.name)) duplicateNames.push(ext.name);
      return;
    }
    seen.set(ext.name, ext);
    if (configSynonyms) {
      // `knowhow.json → voiceControl.synonyms` apply to every command.
      const synonyms = mergeSynonyms(ext.synonyms, configSynonyms);
      const aliases = aliasesWithSynonyms(ext.phrase, ext.aliases ?? [], synonyms);
      collected.push({ ...ext, synonyms, aliases, source });
    } else {
      collected.push({ ...ext, source });
    }
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

  const { commands, overridden } = applyOverrides(collected);
  const conflicts = analyzeCommands(commands, duplicateNames);
  return { commands, conflicts, overridden };
}

/** `collectVoiceCommandReport(...).commands`; conflicts are reported through `options.warn`. */
export function collectVoiceCommands(options: CollectVoiceCommandsOptions = {}): RegisteredVoiceCommand[] {
  const report = collectVoiceCommandReport(options);
  for (const conflict of report.conflicts) options.warn?.(conflict.message);
  return report.commands;
}

/** `knowhow.json → voiceControl.synonyms` (`{ hints: ["map"] }`), validated. */
export function readConfigSynonyms(config: unknown): Record<string, string[]> | undefined {
  const raw = (config as any)?.voiceControl?.synonyms;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const merged = mergeSynonyms(raw as Record<string, string[]>);
  return Object.keys(merged).length ? merged : undefined;
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
  live: ReadonlyArray<{ phrase: string; aliases?: string[]; description?: string }> = []
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
    Math.min(i === 4 ? 1000 : 40, Math.max(h.length, ...cells.map((c) => c[i].length)))
  );
  const fit = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s.padEnd(w));
  const line = (c: string[]) =>
    c
      .map((s, i) => (i === c.length - 1 ? s : fit(s, widths[i])))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n") + "\n";
}
