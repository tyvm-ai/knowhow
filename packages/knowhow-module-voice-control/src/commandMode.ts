/**
 * Command-mode routing and phrase matching (Contract 4).
 *
 * The voice session operates in one of two modes:
 *   - "command" — utterances are matched against built-in and dynamic hooks;
 *                 they are NOT sent to the agent.
 *   - "agent"   — utterances go to the agent as today.
 *
 * Mode transitions:
 *   command → agent : wake phrase detected (VoiceSession handles) OR "agent mode"
 *   agent → command : "command mode" OR sleep command
 */

import { randomUUID } from "crypto";
import { GazeSample } from "./eyeTracking";
import { GazeClient, GAZE_TIMEOUT, resolveGazeHubUrl } from "./gaze";
import { VoiceCommandSpec, VoiceCommandEvent, VoiceHubEvent, postVoiceCommand } from "./voiceHub";
import type { CommandSource, UtteranceTiming } from "./types";
import { parseUtterance, ParseResult, ParsedCommand } from "./grammar";
import {
  BUILTIN_VOICE_COMMANDS,
  RegisteredVoiceCommand,
  VoiceCommandContext,
  collectVoiceCommands,
  commandModes,
} from "./voiceCommands";

// ─── Types ───────────────────────────────────────────────────────────────────

export type VoiceMode = "command" | "agent";

/** Built-in command hook — returns true if it handled the utterance. */
export type BuiltInHandler = (
  text: string,
  spokenAt: number,
  gaze: GazeSample | undefined,
) => Promise<boolean> | boolean;

export interface CommandMatchResult {
  matched: true;
  /** Canonical phrase from the registered or dynamic table. */
  phrase: string;
  /** "builtin", "module", "config" (knowhow.json) or "dynamic" (hub-registered). */
  source: CommandSource;
  /** Registered command name (not set for dynamic hub phrases). */
  command?: string;
  /** Epoch ms the command was dispatched (hub post returned / handler finished). */
  dispatchedAt?: number;
}

export interface CommandNoMatch {
  matched: false;
}

export type CommandMatch = CommandMatchResult | CommandNoMatch;

// ─── Phrase normalisation & matching ─────────────────────────────────────────

/** Normalise for matching: lowercase, strip punctuation, collapse spaces. */
export function normalisePhrase(text: string): string {
  return text
    .toLowerCase()
    // Normalise curly/right apostrophes to straight apostrophe BEFORE stripping.
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein edit distance. */
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
 * Fuzzy phrase match. Handles:
 *  - Exact match after normalisation
 *  - Alias matching
 *  - F4: Edit-distance tolerance ONLY for tokens ≥ 5 chars (phrases ≥ 8 chars);
 *    short tokens/words must match exactly to prevent "lick"→"click" etc.
 *  - Common Whisper OCR variants: run-together words ("eyecontrol" → "eye control")
 */
export function matchPhrase(
  text: string,
  specs: ReadonlyArray<{ phrase: string; aliases?: string[] }>,
): { matched: true; phrase: string } | { matched: false } {
  const normalized = normalisePhrase(text);
  // Remove token-level punctuation for compact check
  const compact = normalized.replace(/'/g, "");

  for (const spec of specs) {
    const candidates = [
      spec.phrase,
      ...(spec.aliases ?? []),
    ].map(normalisePhrase);

    for (const candidate of candidates) {
      if (normalized === candidate) return { matched: true, phrase: spec.phrase };
      const candidateCompact = candidate.replace(/'/g, "");
      // allow removing internal spaces (Whisper concatenation: "eyecontrol mouse")
      if (compact.replace(/\s/g, "") === candidateCompact.replace(/\s/g, "")) {
        return { matched: true, phrase: spec.phrase };
      }
      // F4: Edit-distance tolerance only for longer phrases/tokens.
      // Single-word commands ≤ 6 chars must match exactly (prevents "lick"→"click").
      // Multi-word phrases where every token is ≥ 6 chars, or total phrase ≥ 8 chars
      // with all tokens ≥ 6 chars: allow 1 edit on the whole phrase.
      const tokens = candidate.split(" ");
      const isSingleShortWord = tokens.length === 1 && candidate.length <= 6;
      if (isSingleShortWord) {
        // Exact only (already checked above) — no fuzzy for short single words.
      } else if (candidate.length >= 8 && tokens.every((t) => t.length >= 6)) {
        const maxEdits = 1;
        if (editDistance(normalized, candidate) <= maxEdits) {
          return { matched: true, phrase: spec.phrase };
        }
      } else if (tokens.length > 1 && tokens.every((t) => t.length >= 6)) {
        // Multi-word where all tokens ≥ 6 chars: allow 1 edit
        if (editDistance(normalized, candidate) <= 1) {
          return { matched: true, phrase: spec.phrase };
        }
      }
    }
  }
  return { matched: false };
}

// ─── Built-in phrase table ────────────────────────────────────────────────────

/**
 * Built-in phrases, derived from the registered built-in voice commands
 * (`BUILTIN_VOICE_COMMANDS` in voiceCommands.ts). Kept for compatibility.
 */
export const BUILTIN_COMMAND_SPECS: VoiceCommandSpec[] = BUILTIN_VOICE_COMMANDS.map((c) => ({
  phrase: c.phrase,
  aliases: [...(c.aliases ?? [])],
  description: c.description,
}));

// ─── Mode router ─────────────────────────────────────────────────────────────

/** Gaze for a routed utterance: a sample, nothing, or a lazy lookup. */
export type GazeInput = GazeSample | undefined | (() => Promise<GazeSample | undefined>);

export interface RouteExtras {
  /** Epoch ms STT finished (defaults to now). */
  recognizedAt?: number;
  /** Latency breakdown from the transcript source. */
  timing?: UtteranceTiming;
}

export interface RegisteredCommandInvocation {
  phrase: string;
  text: string;
  spokenAt: number;
  recognizedAt: number;
  gaze?: GazeSample;
  utteranceId: string;
  slots?: Record<string, unknown>;
  repeat?: number;
}

export interface ModeRouterOptions {
  /**
   * Called when a dynamic hub command is matched; the router posts the
   * VoiceCommandEvent to the hub then calls this.
   */
  onDynamicCommand?: (event: VoiceCommandEvent) => void;
  /**
   * Called when a built-in command is matched (compatibility hook).
   */
  onBuiltinCommand?: (phrase: string, spokenAt: number, gaze: GazeSample | undefined) => void | Promise<void>;
  /**
   * Called when any registered command (built-in, module, knowhow.json) is
   * matched. The session builds the VoiceCommandContext and calls `run`.
   */
  onRegisteredCommand?: (command: RegisteredVoiceCommand, invocation: RegisteredCommandInvocation) => void | Promise<void>;
  /**
   * Called when an utterance in command mode matches nothing.
   */
  onUnmatched?: (text: string) => void;
  /**
   * Called when mode changes.
   */
  onModeChanged?: (mode: VoiceMode) => void;
  /** Hub URL for posting events. */
  hubUrl?: string;
  /** Registered commands (default: built-ins only). */
  commands?: RegisteredVoiceCommand[];
}

function sourceKind(source: string): CommandSource {
  if (source === "built-in") return "builtin";
  if (source === "knowhow.json") return "config";
  return "module";
}

async function resolveGaze(gaze: GazeInput): Promise<GazeSample | undefined> {
  if (typeof gaze === "function") {
    try {
      return await gaze();
    } catch {
      return undefined;
    }
  }
  return gaze;
}

export class ModeRouter {
  private mode: VoiceMode = "command";
  private dynamicSpecs: VoiceCommandSpec[] = [];
  private commands: RegisteredVoiceCommand[];

  constructor(private readonly options: ModeRouterOptions = {}) {
    this.commands = options.commands ?? collectVoiceCommands();
  }

  getMode(): VoiceMode {
    return this.mode;
  }

  setMode(mode: VoiceMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onModeChanged?.(mode);
  }

  setDynamicSpecs(specs: VoiceCommandSpec[]): void {
    this.dynamicSpecs = specs;
  }

  getDynamicSpecs(): VoiceCommandSpec[] {
    return this.dynamicSpecs;
  }

  setRegisteredCommands(commands: RegisteredVoiceCommand[]): void {
    this.commands = commands;
  }

  getRegisteredCommands(): RegisteredVoiceCommand[] {
    return this.commands;
  }

  /** All currently active phrases (dynamic + registered), used to build STT prompt. */
  allPhrases(): string[] {
    const phrases: string[] = [];
    for (const s of [...this.dynamicSpecs, ...this.commands]) {
      phrases.push(s.phrase);
      if (s.aliases) phrases.push(...s.aliases);
    }
    return [...new Set(phrases)];
  }

  /** Match registered commands enabled in `mode` using the grammar engine.
   * Returns the command and its parsed slots/repeat, or undefined if no match. */
  matchRegistered(
    text: string,
    mode: VoiceMode = this.mode,
  ): RegisteredVoiceCommand | undefined {
    const result = this.matchRegisteredWithSlots(text, mode);
    return result?.command;
  }

  /** Grammar-based match returning slots and repeat in addition to the command. */
  matchRegisteredWithSlots(
    text: string,
    mode: VoiceMode = this.mode,
    ctx: Record<string, unknown> = {},
  ): { command: RegisteredVoiceCommand; slots: Record<string, unknown>; repeat: number } | undefined {
    const candidates = this.commands.filter((c) => commandModes(c).includes(mode));
    // Use the full grammar engine (patterns + phrase fallback).
    const parsed = parseUtterance(text, candidates, ctx);
    if (parsed.kind === "none") return undefined;
    if (parsed.kind === "match") {
      return {
        command: parsed.result.command as RegisteredVoiceCommand,
        slots: parsed.result.slots,
        repeat: parsed.result.repeat,
      };
    }
    // Chain: return the first command (caller handles chains separately)
    return {
      command: parsed.results[0].command as RegisteredVoiceCommand,
      slots: parsed.results[0].slots,
      repeat: parsed.results[0].repeat,
    };
  }

  /** Parse an utterance as a potentially chained command sequence. */
  parseRegistered(
    text: string,
    mode: VoiceMode = this.mode,
    ctx: Record<string, unknown> = {},
  ): import("./grammar").ParseResult {
    const candidates = this.commands.filter((c) => commandModes(c).includes(mode));
    return parseUtterance(text, candidates, ctx);
  }

  /**
   * Route a transcript final in command mode. Returns the match result.
   * Never throws.
   */
  async routeCommandModeUtterance(
    text: string,
    utteranceId: string,
    spokenAt: number,
    gaze: GazeInput,
    extras: RouteExtras = {},
  ): Promise<CommandMatch> {
    const recognizedAt = extras.recognizedAt ?? Date.now();
    // Dynamic (automation hub) specs win over registered commands.
    const dynamicMatch = matchPhrase(text, this.dynamicSpecs);
    if (dynamicMatch.matched) {
      // Never wait for a gaze lookup here: the hub owns gaze history and
      // attaches the sample nearest spokenAt itself.
      const event: VoiceCommandEvent = {
        type: "voice.command",
        id: utteranceId,
        phrase: dynamicMatch.phrase,
        text,
        spokenAt,
        recognizedAt,
        ...(typeof gaze === "function" || !gaze ? {} : { gaze }),
        ...(extras.timing ? { timing: { ...extras.timing } } : {}),
      };
      try {
        await postVoiceCommand(event, this.options.hubUrl);
      } catch {
        // fire and forget
      }
      const dispatchedAt = Date.now();
      if (event.timing) event.timing.dispatchedAt = dispatchedAt;
      this.options.onDynamicCommand?.(event);
      return { matched: true, phrase: dynamicMatch.phrase, source: "dynamic", dispatchedAt };
    }

    // Grammar-based parse (supports patterns, slots, repeat, chains).
    const parsed = this.parseRegistered(text, "command");

    if (parsed.kind === "none") {
      this.options.onUnmatched?.(text);
      return { matched: false };
    }

    // Build a list of commands to execute (chain or single).
    const steps: Array<{ command: RegisteredVoiceCommand; slots: Record<string, unknown>; repeat: number }> =
      parsed.kind === "chain"
        ? parsed.results.map((r) => ({
            command: r.command as RegisteredVoiceCommand,
            slots: r.slots,
            repeat: r.repeat,
          }))
        : [{
            command: parsed.result.command as RegisteredVoiceCommand,
            slots: parsed.result.slots,
            repeat: parsed.result.repeat,
          }];

    const sample = await resolveGaze(gaze);
    // Use the phrase of the first command for the match result.
    const firstCommand = steps[0].command;
    const firstSource = sourceKind(firstCommand.source);

    try {
      for (const step of steps) {
        const source = sourceKind(step.command.source);
        if (source === "builtin") {
          await this.options.onBuiltinCommand?.(step.command.phrase, spokenAt, sample);
        }
        await this.options.onRegisteredCommand?.(step.command, {
          phrase: step.command.phrase,
          text,
          spokenAt,
          recognizedAt,
          gaze: sample,
          utteranceId,
          slots: step.slots,
          repeat: step.repeat,
        });
      }
    } catch {
      // command errors don't propagate
    }
    return {
      matched: true,
      phrase: firstCommand.phrase,
      source: firstSource,
      command: firstCommand.name,
      dispatchedAt: Date.now(),
    };
  }

  /**
   * Check whether text is a mode-switch command (works in any mode).
   * Returns the new mode or undefined if not a mode command.
   */
  detectModeSwitch(text: string): VoiceMode | undefined {
    const n = normalisePhrase(text);
    if (/^(?:command mode|go to command mode|switch to command mode)$/.test(n)) return "command";
    if (/^(?:agent mode|go to agent mode|switch to agent mode)$/.test(n)) return "agent";
    return undefined;
  }
}

// ─── Gaze-follow state (in-process mouse control) ────────────────────────────

export interface GazeFollowOptions {
  /** Hz, default 30 */
  pollHz?: number;
  /** EMA smoothing alpha, default 0.3 */
  alpha?: number;
  /** Dead-zone in pixels — don't move if delta < this, default 4 */
  deadZone?: number;
  hubUrl?: string;
}

export interface MouseMover {
  moveMouse(x: number, y: number): Promise<void>;
  clickAt(x: number, y: number, button?: "left" | "right"): Promise<void>;
  doubleClickAt(x: number, y: number): Promise<void>;
  /** Click wherever the pointer currently is, without moving it ("click that"). */
  clickHere?(button?: "left" | "right"): Promise<void>;
}

/**
 * Adapt a computer-use `ComputerService` to a MouseMover.
 *
 * ComputerService.moveMouse takes a Point ({x, y}) and the service has no
 * clickAt/doubleClickAt. Calling `moveMouse(x, y)` with bare numbers gave the
 * driver NaN coordinates, which macOS resolves to the top-left corner (the
 * "eye control mouse gets stuck top-left" bug), and voice "click" threw a
 * swallowed TypeError so it never clicked.
 */
export function mouseMoverFromComputerService(service: {
  moveMouse(p: { x: number; y: number }): Promise<void>;
  click(button?: "left" | "right" | "middle", opts?: { double?: boolean }): Promise<void>;
}): MouseMover {
  const finite = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y);
  return {
    moveMouse: async (x, y) => {
      if (finite(x, y)) await service.moveMouse({ x, y });
    },
    clickAt: async (x, y, button) => {
      if (!finite(x, y)) return;
      await service.moveMouse({ x, y });
      await service.click(button ?? "left");
    },
    doubleClickAt: async (x, y) => {
      if (!finite(x, y)) return;
      await service.moveMouse({ x, y });
      await service.click("left", { double: true });
    },
    clickHere: async (button) => {
      await service.click(button ?? "left");
    },
  };
}

export class GazeFollowController {
  private timer?: NodeJS.Timeout;
  private smoothX = 0;
  private smoothY = 0;
  private hasFirst = false;
  private readonly alpha: number;
  private readonly deadZone: number;
  private readonly hubUrl: string;
  private readonly gaze: GazeClient;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly mover: MouseMover,
    private readonly options: GazeFollowOptions = {},
  ) {
    this.alpha = options.alpha ?? 0.3;
    this.deadZone = options.deadZone ?? 4;
    this.hubUrl = options.hubUrl ?? resolveGazeHubUrl();
    this.gaze = new GazeClient({ hubUrl: this.hubUrl });
  }

  isRunning(): boolean {
    return !!this.timer;
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.round(1000 / (this.options.pollHz ?? 30));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.hasFirst = false;
  }

  private async tick(): Promise<void> {
    try {
      const sample = await this.gaze.current({ timeoutMs: GAZE_TIMEOUT.tick });
      if (!sample) return;
      if (!this.hasFirst) {
        this.smoothX = sample.x;
        this.smoothY = sample.y;
        this.hasFirst = true;
      } else {
        this.smoothX = this.alpha * sample.x + (1 - this.alpha) * this.smoothX;
        this.smoothY = this.alpha * sample.y + (1 - this.alpha) * this.smoothY;
      }
      const dx = Math.abs(this.smoothX - this.lastX);
      const dy = Math.abs(this.smoothY - this.lastY);
      if (dx < this.deadZone && dy < this.deadZone) return;
      this.lastX = Math.round(this.smoothX);
      this.lastY = Math.round(this.smoothY);
      await this.mover.moveMouse(this.lastX, this.lastY);
    } catch {
      // ignore transient errors
    }
  }

  /** Get the current smoothed position (for click commands). */
  currentPosition(): { x: number; y: number } | undefined {
    if (!this.hasFirst) return undefined;
    return { x: Math.round(this.smoothX), y: Math.round(this.smoothY) };
  }
}

// ─── Quick-hook executor ──────────────────────────────────────────────────────

/**
 * Fetches gaze history from hub and returns sample nearest `epochMs`.
 * Uses a tight timeout (default 150 ms) — it sits on the command latency path.
 */
export async function gazeNearestTime(
  epochMs: number,
  hubUrl: string,
  timeoutMs: number = GAZE_TIMEOUT.fast,
): Promise<GazeSample | undefined> {
  const sample = await new GazeClient({ hubUrl }).at(epochMs, { windowMs: 1500, timeoutMs });
  return sample ?? undefined;
}

export interface QuickHookContext {
  gazeFollow: GazeFollowController;
  mover: MouseMover;
  hubUrl: string;
}

/** Build the context passed to `VoiceCommandExtension.run`. */
export function buildVoiceCommandContext(params: {
  phrase: string;
  text: string;
  spokenAt: number;
  recognizedAt: number;
  gaze?: GazeSample;
  mouse?: MouseMover;
  gazeFollow?: GazeFollowController;
  setMode?: (mode: VoiceMode) => void;
  log?: (msg: string) => void;
  slots?: Record<string, unknown>;
  repeat?: number;
  actions?: import("./actions/types").PlatformActions;
  history?: unknown[];
}): VoiceCommandContext {
  const { gaze, gazeFollow } = params;
  return {
    phrase: params.phrase,
    text: params.text,
    spokenAt: params.spokenAt,
    recognizedAt: params.recognizedAt,
    gaze,
    mouse: params.mouse,
    gazeFollow,
    target: () =>
      gazeFollow?.isRunning()
        ? gazeFollow.currentPosition()
        : (gaze ? { x: gaze.x, y: gaze.y } : undefined),
    setMode: params.setMode ?? (() => undefined),
    log: params.log ?? (() => undefined),
    slots: params.slots ?? {},
    repeat: params.repeat ?? 1,
    actions: params.actions,
    history: params.history,
  };
}

/**
 * Execute a built-in quick hook. Returns true if handled.
 * (Compatibility wrapper — built-ins are VoiceCommandExtensions now.)
 */
export async function executeBuiltinHook(
  phrase: string,
  spokenAt: number,
  gazeAtOnset: GazeSample | undefined,
  ctx: QuickHookContext,
): Promise<boolean> {
  const command = BUILTIN_VOICE_COMMANDS.find((c) => c.phrase === phrase);
  // Mode switches are handled by the router/session, not here.
  if (!command || command.name.endsWith("-mode")) return false;
  await command.run(buildVoiceCommandContext({
    phrase,
    text: phrase,
    spokenAt,
    recognizedAt: Date.now(),
    gaze: gazeAtOnset,
    mouse: ctx.mover,
    gazeFollow: ctx.gazeFollow,
  }));
  return true;
}

// ─── Helper: build STT prompt from active phrase list ─────────────────────────

export function buildCommandSttPrompt(phrases: string[], wakePhrase?: string): string {
  const parts: string[] = [];
  if (wakePhrase) parts.push(wakePhrase);
  parts.push("Knowhow voice control.");
  if (phrases.length) parts.push(phrases.slice(0, 30).join(". ") + ".");
  return parts.join(" ");
}
