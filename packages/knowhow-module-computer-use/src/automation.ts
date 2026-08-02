import * as fs from "fs";
import * as path from "path";
import {
  AccessibilityElement,
  AccessibilityOptions,
  Point,
  Region,
} from "@tyvm/knowhow";
import {
  ComputerService,
  ColorRegion,
  DesktopBox,
  DesktopShape,
  OcrResult,
  ReadTextOptions,
} from "./ComputerService";
import { resolveRegionAsync } from "./regions";

/**
 * Automations — a locally-run perception→action loop that the LLM authors once
 * (after watching a game/UI) and then launches with a single tool call. The LLM
 * (the slow, smart "coach") stays OUT of the per-frame loop; the automation (the
 * fast, dumb "actor") runs entirely in-process at a tight interval with no model
 * round-trip per target, which is the only way to beat the ~1s human bar.
 *
 * Design (see .knowhow/tasks/computer-use-improvements/implementation-plan.md):
 *  - The automation is a .ts async function body with access to a small `sdk`.
 *  - It can call `await sdk.requiredWindow(...)`; if OS focus leaves that window
 *    the runner auto-pauses (action methods become no-ops), so a human
 *    interrupts any automation just by clicking away / Cmd-Tabbing out.
 *  - It supports `dryRun`, where action methods RECORD intent instead of moving
 *    the real mouse — this powers offline testAutomation against a recording.
 */

const STORE_DIR = path.join(".knowhow", "automations");

/**
 * Hard ceiling on how long ANY automation may run before it is force-stopped.
 * Automations take over the real mouse/keyboard, so a human needs to be able to
 * reliably reclaim control quickly. We cap every run at 10s (regardless of what
 * the caller requests) so a runaway automation can never hold the mouse hostage
 * for longer than that. Re-launch the automation if you legitimately need more time.
 */
export const MAX_AUTOMATION_DURATION_MS = 30000;

/** Default run duration when the caller doesn't specify one. */
export const DEFAULT_AUTOMATION_DURATION_MS = 30000;

export interface WindowMatch {
  /** Substring (case-insensitive) that must appear in the active window title. */
  titleIncludes?: string;
  /** Substring (case-insensitive) that must appear in the active window app. */
  app?: string;
}

export interface AutomationSpec {
  name: string;
  /** Async function body. Receives (sdk). May `await` sdk.* calls. */
  script: string;
  /** Parsed structured header (see parseAutomationDoc) describing when to use it. */
  doc?: AutomationDoc;
  /** Absolute path to the saved .ts file (populated by loaders). */
  filePath?: string;
}

/**
 * Structured "skill card" for an automation, parsed from a JSDoc-style header
 * comment at the very top of the script. This is what makes an automation
 * DISCOVERABLE: it tells a future agent what the automation does, WHEN to reach
 * for it, what the screen must look like before it runs, and what it leaves
 * behind afterward — so the agent can pick the right automation without reading
 * (or guessing at) the whole implementation.
 */
export interface AutomationDoc {
  description?: string;
  useWhen?: string;
  startState?: string;
  endState?: string;
  window?: string;
  notes?: string;
}

export interface AutomationAction {
  t: number;
  kind:
    | "clickAt"
    | "moveMouse"
    | "type"
    | "key"
    | "hotkey"
    | "focus"
    | "selectAccessibilityOption"
    | "setAccessibilityValue"
    | "performAccessibilityAction";
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  /** True when the runner suppressed this action (paused / dry-run). */
  suppressed?: boolean;
}

export interface AutomationLogEntry {
  t: number;
  data: any;
}

export interface AutomationRunResult {
  name: string;
  elapsedMs: number;
  stopped: "duration" | "manual" | "completed" | "error";
  error?: string;
  actions: AutomationAction[];
  actionCount: number;
  logs: AutomationLogEntry[];
  pausedMs: number;
  dryRun: boolean;
  /** The window gate that was in effect (if any) — the focus-loss auto-pause. */
  requiredWindow?: WindowMatch;
  /**
   * True when a LIVE run performed real actions without ever configuring a
   * required-window gate. Such a run can't be reclaimed by clicking away, so
   * callers should treat this as a warning.
   */
  ranWithoutWindowGate?: boolean;
}

export interface AutomationControl {
  paused: boolean;
  stopped: boolean;
  requiredWindow?: WindowMatch;
  stop(): void;
}

/**
 * The surface handed to an authored automation script. Perception methods read
 * real rendered pixels; action methods drive the real mouse/keyboard (unless
 * paused or in dry-run). Everything is in ABSOLUTE DESKTOP coordinates.
 */
export interface AutomationSDK {
  // ── perception (real pixels) ──
  screenSize(): Promise<{ width: number; height: number }>;
  /** Return the currently focused window, if one can be identified. */
  activeWindow(): Promise<{ title: string; app?: string; bounds?: Region } | null>;
  /**
   * Inspect the focused window's native accessibility tree. Element IDs are
   * short-lived: discover and use an element before requesting another tree.
   */
  accessibilityTrusted(): Promise<boolean>;
  accessibilityElements(opts?: AccessibilityOptions): Promise<AccessibilityElement[]>;
  findColor(
    colors: string | string[],
    opts?: {
      region?: Region | string;
      tolerance?: number;
      minPixels?: number;
      minSize?: number;
      maxSize?: number;
    }
  ): Promise<ColorRegion[]>;
  findShape(opts: {
    kind: "line-h" | "line-v" | "rect" | "square" | "circle" | "blob";
    color?: string;
    region?: Region | string;
    tolerance?: number;
    minSize?: number;
    maxSize?: number;
    length?: number;
    thickness?: number;
  }): Promise<DesktopShape[]>;
  findBoxes(opts?: {
    region?: Region | string;
    minSize?: number;
    maxSize?: number;
    minEdgeScore?: number;
    maxBoxes?: number;
  }): Promise<DesktopBox[]>;
  /**
   * Detect UI element regions by color segmentation, returned as a nested
   * containment hierarchy in ABSOLUTE DESKTOP coords (each box: bounds, center,
   * area, depth, children). Useful for "find the clickable things in the play
   * area" without knowing their exact color:
   *  - mode "panels" (default here): find large flat BACKGROUND surfaces and
   *    group the FOREGROUND content on each into element boxes (score readouts,
   *    button rows) — i.e. things that AREN'T the background color.
   *  - mode "colors": one box per contiguous same-color area, nested.
   *  - mode "foreground": everything differing from the dominant background.
   * Pass a region to constrain the search (e.g. the playfield) so you only get
   * targets inside the game area.
   */
  findRegions(opts?: {
    region?: Region | string;
    mode?: "foreground" | "colors" | "panels";
    minSize?: number;
    colorBits?: number;
    clusterGap?: number;
    minPixels?: number;
    maxBoxes?: number;
  }): Promise<DesktopBox[]>;
  pixelColor(x: number, y: number): Promise<string>;

  // ── action (no-op while paused; recorded in dry-run) ──
  clickAt(x: number, y: number, button?: "left" | "right" | "middle"): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  /** Press a key chord, e.g. `["command", "a"]`. */
  hotkey(keys: string[]): Promise<void>;
  /** Focus an app/window. Call before installing requiredWindow. */
  focus(match: string): Promise<boolean>;
  /** Select a pop-up/combo-box option without keyboard type-ahead. */
  selectAccessibilityOption(id: string, option: string): Promise<void>;
  /** Set a settable accessibility element value using a fresh discovered ID. */
  setAccessibilityValue(id: string, value: string): Promise<void>;
  /** Perform an allowlisted AX action (for example AXPress or AXShowMenu). */
  performAccessibilityAction(id: string, action: string): Promise<void>;

  // ── control / telemetry ──
  sleep(ms: number): Promise<void>;
  now(): number;
  elapsed(): number;
  log(data: any): void;
  /**
   * Run this callback repeatedly on a fixed interval (in MILLISECONDS, like
   * setInterval) until the run is stopped (or the max duration cap is
   * reached). The interval is measured between iteration starts; if a callback
   * overruns its interval it simply runs again immediately (after a yield).
   * Pass `intervalMs` of 0 to run as fast as possible. Optionally pass
   * `{ requiredWindow }` to gate the loop on a focused window in one call —
   * equivalent to awaiting sdk.requiredWindow(match) first, so actions auto-
   * pause the moment focus leaves that window (the primary way a human reclaims
   * the mouse mid-run).
   */
  runEvery(
    callback: () => void | Promise<void>,
    intervalMs: number,
    opts?: { requiredWindow?: WindowMatch }
  ): Promise<void>;
  /** Set/clear the focus gate. Await before performing actions. */
  requiredWindow(match?: WindowMatch): Promise<void>;
  /**
   * Read text from the screen (or a named/explicit region) using macOS Vision
   * OCR. Returns recognized text regions in ABSOLUTE DESKTOP coordinates,
   * sorted top-to-bottom then left-to-right.
   * Each result: { text, confidence, bounds, center }
   * bounds/center are desktop coords ready for clickAt().
   * Pass a region to restrict OCR to part of the screen — faster, less noise.
   * On non-macOS platforms, returns [].
   */
  readText(opts?: {
    region?: Region | string;
    displayId?: number;
    activeWindow?: boolean;
    minConfidence?: number;
  }): Promise<OcrResult[]>;
  readonly ctl: AutomationControl;
}

/**
 * Editor/type-only binding for authored automation files. At execution time
 * the runner injects the real value and removes its SDK import declaration.
 */
export const sdk: AutomationSDK = undefined as any;

// ── registry (running instances, so stopAutomation can reach them) ──
const running = new Map<string, AutomationRunner>();

export function getRunning(name: string): AutomationRunner | undefined {
  return running.get(name);
}

export function listRunning(): string[] {
  return [...running.keys()];
}

/** Persisted automation storage (git-trackable). */
export function automationPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STORE_DIR, `${safe}.ts`);
}

/**
 * Extract the structured "skill card" from an automation script. We look for a
 * leading block comment (before any executable code) and read JSDoc-style tags:
 *   @description  one-liner of what it does
 *   @useWhen      the situation/trigger that should make an agent pick this
 *   @startState   what the screen must look like BEFORE running
 *   @endState     what the screen will look like AFTER it finishes
 *   @window       the required window (title/app) it operates on
 *   @notes        anything else worth knowing (limits, caveats)
 * Tag text may wrap onto continuation lines. Returns undefined when no
 * recognizable header is present.
 */
export function parseAutomationDoc(script: string): AutomationDoc | undefined {
  const block = script.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (!block) return undefined;
  // Strip leading " * " decoration from each comment line.
  const body = block[1]
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, ""))
    .join("\n");

  const tags: Record<string, string> = {};
  let current: string | null = null;
  const known = new Set([
    "description",
    "usewhen",
    "startstate",
    "endstate",
    "window",
    "notes",
  ]);
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    const m = line.match(/^@(\w+)\s*(.*)$/);
    if (m && known.has(m[1].toLowerCase())) {
      current = m[1].toLowerCase();
      tags[current] = m[2].trim();
    } else if (current && line.trim()) {
      tags[current] = (tags[current] + " " + line.trim()).trim();
    }
  }
  if (!Object.keys(tags).length) return undefined;
  const doc: AutomationDoc = {
    description: tags["description"],
    useWhen: tags["usewhen"],
    startState: tags["startstate"],
    endState: tags["endstate"],
    window: tags["window"],
    notes: tags["notes"],
  };
  // Drop empty keys for a tidy summary.
  for (const k of Object.keys(doc) as (keyof AutomationDoc)[]) {
    if (!doc[k]) delete doc[k];
  }
  return Object.keys(doc).length ? doc : undefined;
}

export function saveAutomation(spec: AutomationSpec): AutomationSpec {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(automationPath(spec.name), spec.script);
  return { ...spec, doc: parseAutomationDoc(spec.script), filePath: automationPath(spec.name) };
}

export function loadAutomation(name: string): AutomationSpec {
  const spec = loadAutomationSafe(name);
  if (!spec) throw new Error(`No automation named "${name}".`);
  return spec;
}

export function loadAutomationSafe(name: string): AutomationSpec | undefined {
  try {
    const p = automationPath(name);
    if (fs.existsSync(p)) {
      const script = fs.readFileSync(p, "utf8");
      return { name, script, doc: parseAutomationDoc(script), filePath: p };
    }
    // Read old files during migration, but all new writes use plain .ts files.
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const legacy = path.join(STORE_DIR, `${safe}.automation.json`);
    if (!fs.existsSync(legacy)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
    return {
      name,
      script: parsed.script,
      doc: parseAutomationDoc(parsed.script || ""),
      filePath: legacy,
    };
  } catch {
    return undefined;
  }
}

export function listAutomations(): AutomationSpec[] {
  try {
    if (!fs.existsSync(STORE_DIR)) return [];
    return fs
      .readdirSync(STORE_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => loadAutomationSafe(f.slice(0, -3)) || null)
      .filter((x): x is AutomationSpec => !!x);
  } catch {
    return [];
  }
}

export function deleteAutomation(name: string): boolean {
  const p = automationPath(name);
  let deleted = false;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    deleted = true;
  }
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const legacy = path.join(STORE_DIR, `${safe}.automation.json`);
  if (fs.existsSync(legacy)) {
    fs.unlinkSync(legacy);
    deleted = true;
  }
  return deleted;
}

/**
 * Reject scripts that try to escape the SDK sandbox. Automations must "play"
 * honestly — only real pixels in, real mouse out — so we forbid network/shell/
 * filesystem/module access. This is a static guard, not a full sandbox; the
 * script still runs with `new Function` and only `sdk` in scope.
 */
const FORBIDDEN_TOKENS = [
  "require",
  "import",
  "process",
  "child_process",
  "fetch",
  "eval",
  "Function",
  "globalThis",
  "__dirname",
  "__filename",
  "XMLHttpRequest",
  "WebSocket",
];

const SDK_IMPORT = /^\s*import\s*\{\s*sdk\s*\}\s*from\s*["']@tyvm\/knowhow-module-computer-use["']\s*;?\s*$/gm;

/** Remove the one editor-only import supported by automation source files. */
export function prepareAutomationScript(script: string): string {
  return script.replace(SDK_IMPORT, "");
}

export function validateScript(script: string): void {
  script = prepareAutomationScript(script);
  for (const tok of FORBIDDEN_TOKENS) {
    const re = new RegExp(`\\b${tok}\\b`);
    if (re.test(script)) {
      throw new Error(
        `Automation script rejected: forbidden token "${tok}". Automations may only use the provided sdk (perception + mouse/keyboard). No network, shell, filesystem, or module access.`
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as {
  new (...args: string[]): (...a: any[]) => Promise<any>;
};

export interface RunOptions {
  maxDurationMs?: number;
  /** When true, action methods record intent but do NOT move the real mouse. */
  dryRun?: boolean;
  /** Poll interval for the window-focus gate (default 200ms). */
  gatePollMs?: number;
  /** Optional callback for streamed telemetry (e.g. push to the coach). */
  onLog?: (entry: AutomationLogEntry) => void;
  /**
   * Delay (ms) between the SDK's moveMouse and the click inside clickAt so the
   * OS commits the new cursor position before the button event — otherwise a
   * click posted back-to-back with a move can register at a stale location
   * (default 40).
   */
  clickSettleMs?: number;
}

/**
 * Runs a single automation instance: builds the SDK, enforces the window gate
 * (auto-pause on focus loss), guards a max duration, and collects telemetry.
 */
export class AutomationRunner {
  readonly spec: AutomationSpec;
  private svc: ComputerService;
  private opts: RunOptions;
  private startedAt = 0;
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;
  private actions: AutomationAction[] = [];
  private logs: AutomationLogEntry[] = [];
  private gateTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  /** True once a non-empty required-window gate has been configured. */
  private everGatedWindow = false;
  /** Resolved max run duration (ms). Set at the start of run(). */
  maxDurationMs = DEFAULT_AUTOMATION_DURATION_MS;
  private stopReason: "duration" | "manual" | "completed" | "error" | null =
    null;

  readonly ctl: AutomationControl = {
    paused: false,
    stopped: false,
    requiredWindow: undefined,
    stop: () => {
      if (!this.ctl.stopped) this.stopReason = this.stopReason ?? "manual";
      this.ctl.stopped = true;
    },
  };

  constructor(spec: AutomationSpec, svc: ComputerService, opts: RunOptions = {}) {
    this.spec = spec;
    this.svc = svc;
    this.opts = opts;
  }

  private now(): number {
    return Date.now();
  }

  elapsed(): number {
    return this.startedAt ? this.now() - this.startedAt : 0;
  }

  private matchesWindow(
    active: { title: string; app?: string } | null,
    match?: WindowMatch
  ): boolean {
    if (!match || (!match.titleIncludes && !match.app)) return true;
    if (!active) return false;
    const title = (active.title || "").toLowerCase();
    const app = (active.app || "").toLowerCase();
    const titleMatches = !match.titleIncludes ||
      title.includes(match.titleIncludes.toLowerCase());
    const appMatches = !match.app || app.includes(match.app.toLowerCase());
    // When both selectors are supplied they describe one target window, not
    // alternatives. Requiring both prevents another Chrome tab from opening
    // the gate merely because its owning application matches.
    return titleMatches && appMatches;
  }

  private async pollGate(): Promise<void> {
    if (this.ctl.stopped) return;
    if (!this.ctl.requiredWindow) return;
    let active: { title: string; app?: string } | null = null;
    try {
      active = (await this.svc.getActiveWindow()) as any;
    } catch {
      active = null;
    }
    const ok = this.matchesWindow(active, this.ctl.requiredWindow);
    if (!ok && !this.ctl.paused) {
      this.ctl.paused = true;
      this.pauseStartedAt = this.now();
      this.emit({
        paused: "window-focus-lost",
        active: active?.title || null,
      });
    } else if (ok && this.ctl.paused) {
      this.ctl.paused = false;
      if (this.pauseStartedAt) {
        this.pausedAccumMs += this.now() - this.pauseStartedAt;
        this.pauseStartedAt = 0;
      }
      this.emit({ resumed: true, active: active?.title || null });
    }
  }

  private async configureRequiredWindow(match?: WindowMatch): Promise<void> {
    this.ctl.requiredWindow = match;
    if (match && (match.titleIncludes || match.app)) {
      this.everGatedWindow = true;
    }
    if (this.gateTimer) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
    if (!match || (!match.titleIncludes && !match.app)) {
      if (this.ctl.paused) {
        this.ctl.paused = false;
        if (this.pauseStartedAt) {
          this.pausedAccumMs += this.now() - this.pauseStartedAt;
          this.pauseStartedAt = 0;
        }
        this.emit({ resumed: true, gateCleared: true });
      }
      return;
    }

    // Awaiting this function guarantees the next action is already gated.
    await this.pollGate();
    const gateMs = Math.max(50, this.opts.gatePollMs ?? 200);
    this.gateTimer = setInterval(() => {
      this.pollGate().catch(() => {});
    }, gateMs);
    if (this.gateTimer.unref) this.gateTimer.unref();
  }

  private emit(data: any): void {
    const entry: AutomationLogEntry = { t: this.elapsed(), data };
    this.logs.push(entry);
    if (this.opts.onLog) {
      try {
        this.opts.onLog(entry);
      } catch {
        /* streaming is best-effort */
      }
    }
  }

  private canAct(): boolean {
    return !this.ctl.stopped && !this.ctl.paused && !this.opts.dryRun;
  }

  private buildSDK(): AutomationSDK {
    const svc = this.svc;
    const self = this;
    const clickSettleMs = Math.max(0, this.opts.clickSettleMs ?? 40);
    const sdk: AutomationSDK = {
      ctl: this.ctl,
      runEvery: async (callback, intervalMs, opts) => {
        if (typeof callback !== "function") {
          throw new Error("sdk.runEvery(callback, intervalMs) requires a function.");
        }
        if (!Number.isFinite(intervalMs) || intervalMs < 0) {
          throw new Error(
            "sdk.runEvery(callback, intervalMs) requires a non-negative interval in milliseconds."
          );
        }
        // Inline focus gate: gate the loop on a window in one call so authors
        // don't forget the requiredWindow guard that lets a human reclaim the
        // mouse just by clicking away.
        if (opts?.requiredWindow) {
          await self.configureRequiredWindow(opts.requiredWindow);
        }
        // Hard backstop: even if the OS-level duration timer is starved (see
        // below), never let this loop outlive the configured max duration.
        const deadline = self.startedAt
          ? self.startedAt + self.maxDurationMs
          : Number.POSITIVE_INFINITY;
        while (!self.ctl.stopped) {
          const iterationStarted = self.now();
          // In-loop duration guard. The setTimeout-based durationTimer is a
          // macrotask; a callback that consistently runs longer than intervalMs
          // (screen capture + shape detection easily do) would otherwise leave
          // `remaining <= 0`, skip the setTimeout yield, and spin as a tight
          // microtask loop — starving timers AND SIGINT so neither the 30s
          // timeout nor Ctrl-C could ever fire. Check the deadline directly.
          if (iterationStarted >= deadline) {
            if (!self.ctl.stopped) {
              self.stopReason = self.stopReason ?? "duration";
              self.ctl.stopped = true;
              self.emit({ stopped: "duration", maxDurationMs: self.maxDurationMs });
            }
            break;
          }
          // A required-window gate scopes perception as well as input. Do not
          // start the callback while paused: OCR/screenshot calls are reads and
          // cannot be suppressed by canAct(), so running them here would capture
          // the terminal used to launch the automation on another display.
          if (self.ctl.paused) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          await callback();
          if (self.ctl.stopped) break;
          const remaining = intervalMs - (self.now() - iterationStarted);
          if (remaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, remaining));
          } else {
            // The callback overran its interval budget (screen capture + shape
            // detection routinely do). Yield with a real timer tick rather than
            // setImmediate: setImmediate callbacks run in the event loop's
            // "check" phase and, when re-queued every iteration, can keep
            // starving the "timers" phase — which is exactly where the /poke
            // input watcher's setInterval and the agent's interrupt handling
            // live. A setTimeout(0) forces the loop through the timers phase
            // each iteration, so /poke (and Ctrl-C) stay responsive while an
            // automation is running hot.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      },
      requiredWindow: (match) => self.configureRequiredWindow(match),

      screenSize: () => svc.screenSize(),
      activeWindow: () => svc.getActiveWindow() as any,
      accessibilityTrusted: () => svc.accessibilityTrusted(),
      accessibilityElements: (o = {}) => svc.accessibilityElements(o),

      findColor: async (colors, o = {}) =>
        svc.findColorRegions({
          colors: Array.isArray(colors) ? colors : [colors],
          region: await resolveRegionAsync(o.region as any, () => svc.getActiveWindow()),
          tolerance: o.tolerance,
          minPixels: o.minPixels,
          minSize: o.minSize,
          maxSize: o.maxSize,
        } as any),

      findShape: async (o) =>
        svc.findShapes({
          kind: o.kind,
          color: o.color,
          region: await resolveRegionAsync(o.region as any, () => svc.getActiveWindow()),
          tolerance: o.tolerance,
          minSize: o.minSize,
          maxSize: o.maxSize,
          length: o.length,
          thickness: o.thickness,
        } as any),

      findBoxes: async (o = {}) =>
        svc.findBoxes({
          region: await resolveRegionAsync(o.region as any, () => svc.getActiveWindow()),
          minSize: o.minSize,
          maxSize: o.maxSize,
          minEdgeScore: o.minEdgeScore,
          maxBoxes: o.maxBoxes,
        } as any),

      findRegions: async (o = {}) =>
        svc.findRegions({
          region: await resolveRegionAsync(o.region as any, () => svc.getActiveWindow()),
          // Default to "panels" in automations: it groups foreground content
          // over background surfaces, which is what "find the clickable things
          // that aren't the background" usually means for a game/UI.
          mode: o.mode ?? "panels",
          minSize: o.minSize,
          colorBits: o.colorBits,
          clusterGap: o.clusterGap,
          minPixels: o.minPixels,
          maxBoxes: o.maxBoxes,
        } as any),

      pixelColor: (x, y) => svc.pixelColor({ x, y }),

      readText: (o = {}) => svc.readText(o as ReadTextOptions),

      clickAt: async (x, y, button = "left") => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "clickAt",
          x,
          y,
          button,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.moveMouse({ x, y });
        // Let the OS commit the cursor move before the button event; a click
        // fired back-to-back with a move can register at a stale position.
        if (clickSettleMs) await new Promise((r) => setTimeout(r, clickSettleMs));
        await svc.click(button);
      },

      moveMouse: async (x, y) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "moveMouse",
          x,
          y,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.moveMouse({ x, y });
      },

      type: async (text) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "type",
          text,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.typeText(text);
      },

      key: async (name) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "key",
          text: name,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.pressKey(name);
      },

      hotkey: async (keys) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "hotkey",
          text: keys.join("+"),
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.hotkey(...keys);
      },

      focus: async (match) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "focus",
          text: match,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        // Intentionally obeys the same dry-run, stopped, and focus-gate pause
        // rules as every other action. Authors that need to establish focus
        // must call this before requiredWindow/runEvery installs its gate.
        if (!self.canAct()) return false;
        return svc.focusWindow(match);
      },

      selectAccessibilityOption: async (id, option) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "selectAccessibilityOption",
          text: JSON.stringify({ id, option }),
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.selectAccessibilityOption(id, option);
      },

      setAccessibilityValue: async (id, value) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "setAccessibilityValue",
          text: JSON.stringify({ id, value }),
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.setAccessibilityValue(id, value);
      },

      performAccessibilityAction: async (id, action) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "performAccessibilityAction",
          text: JSON.stringify({ id, action }),
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.performAccessibilityAction(id, action);
      },

      sleep: (ms) =>
        new Promise((resolve) => {
          const capped = Math.max(0, Math.min(60000, ms || 0));
          setTimeout(resolve, capped);
        }),

      now: () => self.now(),
      elapsed: () => self.elapsed(),
      log: (data) => self.emit(data),
    };
    return sdk;
  }

  async run(): Promise<AutomationRunResult> {
    const script = prepareAutomationScript(this.spec.script);
    validateScript(script);
    running.set(this.spec.name, this);
    this.startedAt = this.now();
    let stopped: AutomationRunResult["stopped"] = "completed";
    let error: string | undefined;

    const maxDurationMs = (this.maxDurationMs = Math.max(
      500,
      Math.min(
        MAX_AUTOMATION_DURATION_MS,
        this.opts.maxDurationMs ?? DEFAULT_AUTOMATION_DURATION_MS
      )
    ));
    this.durationTimer = setTimeout(() => {
      if (!this.ctl.stopped) {
        this.stopReason = "duration";
        this.ctl.stopped = true;
        this.emit({ stopped: "duration", maxDurationMs });
      }
    }, maxDurationMs);
    if (this.durationTimer.unref) this.durationTimer.unref();

    const sdk = this.buildSDK();
    const fn = new AsyncFunction("sdk", script);
    try {
      await fn(sdk);
      // Script returned. The reason is whatever set ctl.stopped (duration/
      // manual), or a clean completion if nothing forced a stop.
      stopped = this.stopReason ?? "completed";
    } catch (e: any) {
      if (this.ctl.stopped && this.stopReason) {
        stopped = this.stopReason;
      } else {
        stopped = "error";
        error = e?.message || String(e);
        this.emit({ error });
      }
    } finally {
      this.ctl.stopped = true;
      if (this.gateTimer) clearInterval(this.gateTimer);
      if (this.durationTimer) clearTimeout(this.durationTimer);
      if (this.pauseStartedAt) {
        this.pausedAccumMs += this.now() - this.pauseStartedAt;
        this.pauseStartedAt = 0;
      }
      running.delete(this.spec.name);
    }

    return {
      name: this.spec.name,
      elapsedMs: this.elapsed(),
      stopped,
      error,
      actions: this.actions,
      actionCount: this.actions.length,
      logs: this.logs,
      pausedMs: this.pausedAccumMs,
      dryRun: !!this.opts.dryRun,
      requiredWindow: this.everGatedWindow ? this.ctl.requiredWindow : undefined,
      ranWithoutWindowGate:
        !this.opts.dryRun &&
        !this.everGatedWindow &&
        this.actions.some((a) => !a.suppressed),
    };
  }
}
