import * as fs from "fs";
import * as path from "path";
import sharpFactory, { Sharp, SharpOptions } from "sharp";
import * as ts from "typescript";
import { ExtensionsService } from "@tyvm/knowhow/ts_build/src/services/ExtensionsService";
import { AutomationExtensions, AUTOMATION_SDK_EXTENSION, AutomationSdkExtension, AutomationExtensionContext, buildExtProxy, resolveExtensions } from "./automationExtensions";
import {
  AccessibilityElement,
  AccessibilityOptions,
  OverlayPrimitive,
  Point,
  Region,
  WindowInfo,
} from "./contracts";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import { worldlines, WorldlineRegistry } from "@tyvm/knowhow-module-worldlines";
import { prologFindPlan } from "@tyvm/knowhow-module-prolog";
import {
  ComputerService,
  ColorRegion,
  DesktopBox,
  DesktopShape,
  OcrResult,
  ReadTextOptions,
} from "./ComputerService";
import { resolveRegionAsync } from "./regions";
import { RustCoreDriver } from "./drivers/RustCoreDriver";
import {
  createObjectTracker,
  createScreenWatcher,
  LogScreenActionOptions,
  ObjectTracker,
  ObjectTrackingOptions,
  ScreenFrame,
  ScreenFrameArtifact,
  ScreenWatcher,
  WatchScreenOptions,
} from "./tracking";
import { analyzeGridFrame, GridVisionOptions, GridVisionResult } from "./gridVision";
import { ClipboardSnapshot, CopySelectionOptions } from "./clipboard";
import { normalizeKeyName, normalizeKeyNames } from "./keyAliases";
import { hasWindowSelectors, windowMatches, WindowMatch } from "./windowMatch";
import { createStore, Store } from "./store";
import { uiAlert, uiConfirm, uiPrompt } from "./dialogs";
import { GuiService } from "./gui/GuiService";
import { HeadlessGuiBackend } from "./gui/backends";
import type { Form } from "./gui/Form";
import type { GuiBackend, WindowSpec } from "./gui/types";
import {
  getHotkeyProvider,
  HotkeyOptions,
  HotkeyProvider,
  HOTKEYS_UNAVAILABLE_MESSAGE,
  createHotkeyTrigger,
} from "./hotkeys";
import { getKillSwitch, isKillSwitchSpec, parseHotkeySpec } from "./hotkeySpec";

export { WindowMatch } from "./windowMatch";
export { Store } from "./store";
export {
  FakeHotkeyProvider,
  HotkeyOptions,
  HotkeyProvider,
  HotkeyRegistration,
  setHotkeyProvider,
  getHotkeyProvider,
} from "./hotkeys";

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
 * True when `ref` looks like a file path rather than a saved automation name:
 * contains a path separator (either flavor, so Windows paths work on any OS)
 * or ends in .ts/.js/.mts/.cts.
 */
export function isAutomationPath(ref: string): boolean {
  return /[\\/]/.test(ref) || /\.(?:ts|js|mts|cts|khs)$/i.test(ref);
}

/**
 * Extra directories searched (after .knowhow/automations) when resolving an
 * automation by NAME. Always includes ./automations; extend via
 * KNOWHOW_AUTOMATION_PATHS (path.delimiter-separated) or `automationPaths`
 * (string[]) in .knowhow/knowhow.json.
 */
export function automationSearchDirs(cwd: string = process.cwd()): string[] {
  const dirs: string[] = [path.resolve(cwd, "automations")];
  const add = (d: unknown) => {
    if (typeof d === "string" && d.trim()) dirs.push(path.resolve(cwd, d.trim()));
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".knowhow", "knowhow.json"), "utf8"));
    if (Array.isArray(cfg?.automationPaths)) cfg.automationPaths.forEach(add);
  } catch {
    /* no config */
  }
  (process.env.KNOWHOW_AUTOMATION_PATHS || "")
    .split(path.delimiter)
    .forEach(add);
  return [...new Set(dirs)];
}

/** Strip a script extension to get the automation name (file basename). */
function automationNameFromPath(file: string): string {
  return path.basename(file).replace(/\.(?:ts|js|mts|cts|khs)$/i, "");
}

/**
 * Forced ceiling on how long an automation may run while the global kill switch
 * is NOT armed. Automations take over the real mouse/keyboard, so a human needs a
 * reliable way to reclaim control. The kill switch (default Ctrl+Alt+Esc, handled
 * by the knowhow computer host outside the script's control) is that way; until
 * it is armed (see {@link isKillSwitchArmed}) every run is clamped to this cap
 * (5 minutes) regardless of what the caller requests. When the kill switch IS
 * armed the clamp is bypassed: `maxDurationMs` is honored as given and defaults
 * to unlimited.
 */
export const MAX_AUTOMATION_DURATION_MS = 300000;

let killSwitchArmedProvider: () => boolean = () => false;

/**
 * Is the global kill switch armed (host hook running, permissions granted)?
 * Returns false until the host exists (M1).
 */
export function isKillSwitchArmed(): boolean {
  try {
    return !!killSwitchArmedProvider();
  } catch {
    return false;
  }
}

/** Hook for the host (and tests) to report kill-switch availability. */
export function setKillSwitchArmed(armed: boolean | (() => boolean)): void {
  killSwitchArmedProvider = typeof armed === "function" ? armed : () => armed;
}

/** Default run duration when the caller doesn't specify one. */
export const DEFAULT_AUTOMATION_DURATION_MS = 30000;

export interface AutomationSpec {
  name: string;
  /** Async function body. Receives (sdk). May `await` sdk.* calls. */
  script: string;
  /** Parsed structured header (see parseAutomationDoc) describing when to use it. */
  doc?: AutomationDoc;
  /** Absolute path to the saved .ts file (populated by loaders). */
  filePath?: string;
  /**
   * Directory that relative imports (`./helper`) resolve against. Defaults to
   * the store dir (.knowhow/automations); set to the script's directory for
   * path-based / search-dir automations.
   */
  baseDir?: string;
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
    | "dragMouse"
    | "type"
    | "key"
    | "hotkey"
    | "click"
    | "keyDown"
    | "keyUp"
    | "clipboardWrite"
    | "copySelection"
    | "focus"
    | "selectAccessibilityOption"
    | "setAccessibilityValue"
    | "performAccessibilityAction";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  duration?: number;
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
  /** Action-aligned frame files persisted by ScreenWatcher.logAction(). */
  artifacts: ScreenFrameArtifact[];
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

export interface AutomationClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  snapshot(): Promise<ClipboardSnapshot>;
  restore(snapshot: ClipboardSnapshot): Promise<void>;
  /** Resolves true when the clipboard changed, false on timeout. */
  waitForChange(opts?: { timeoutMs?: number }): Promise<boolean>;
}

export interface AutomationUi {
  beep(opts?: { freq?: number; ms?: number }): Promise<void>;
  /** Transient text near the cursor (macOS overlay; logged elsewhere). */
  tooltip(text: string, opts?: { ms?: number }): Promise<void>;
  /** Native dialog via the host when attached, else an OS fallback. */
  alert(message: string, opts?: { title?: string }): Promise<void>;
  confirm(message: string, opts?: { title?: string }): Promise<boolean>;
  /** `opts` may be a plain string (the default value) for backwards compatibility. */
  prompt(
    message: string,
    opts?: string | { title?: string; default?: string }
  ): Promise<string | null>;
}

/** Native forms (`sdk.gui.form(spec)`); see src/gui. */
export interface AutomationGui {
  /**
   * Create a native form (hidden). Call `form.show()` to display it. An
   * existing form keeps the automation alive until `form.destroy()`.
   */
  form(spec: WindowSpec): Promise<Form>;
}

export interface AutomationTray {
  /** Short status text shown next to this automation in the tray ("" clears). */
  setStatus(text: string): void;
  /** Add a tray menu item for this automation; `fn` runs when clicked. Returns its id. */
  addMenuItem(label: string, fn: () => void | Promise<void>): string;
}

/** Host-provided tray hooks for a run (see src/host). */
export interface TrayBridge {
  setStatus(text: string): void;
  addMenuItem(id: string, label: string, fn: () => void | Promise<void>): void;
}

export interface AutomationHotkeys {
  /** Register a global hotkey; returns its id. Throws on the kill-switch chord. */
  on(spec: string, fn: () => void | Promise<void>, opts?: HotkeyOptions): string;
  off(id: string): void;
  /** Resolve once `key` is physically released (AHK `KeyWait`). */
  waitRelease(key: string): Promise<void>;
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
  activeWindow(): Promise<WindowInfo | null>;
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
    /** Native capture scale in (0, 1]. Use 0.25 for fast tracking while all
     * returned bounds and detector size thresholds remain desktop-relative. */
    scale?: number;
    mode?: "foreground" | "colors" | "panels";
    minSize?: number;
    colorBits?: number;
    clusterGap?: number;
    dilate?: number;
    minPixels?: number;
    maxBoxes?: number;
  }): Promise<DesktopBox[]>;
  pixelColor(x: number, y: number): Promise<string>;
  /** Sample many points from a single frame, preserving input order. */
  pixelColors(points: Point[]): Promise<string[]>;
  /**
   * Classify one captured frame into logical cells, reusable visual patterns,
   * and same-colour components without taking a second screenshot.
   */
  analyzeGrid(frame: ScreenFrame, opts: GridVisionOptions): GridVisionResult;
  /**
   * Create a Sharp image pipeline from an in-memory Buffer or ScreenFrame.
   * ScreenFrames are automatically interpreted as raw RGBA pixels. Prefer
   * `toBuffer()` and `watcher.logAction({ frame: renderedFrame })` so rendered
   * evidence stays inside the automation artifact lifecycle.
   */
  sharp(input: Buffer | ScreenFrame, options?: SharpOptions): Sharp;
  /**
   * Start a persistent ScreenCaptureKit latest-frame stream. Unlike screenshot
   * polling this pays capture setup once and normally receives frames at display
   * refresh speed. Always call stop(); the runner also stops leaked streams.
   */
  watchScreen(opts?: Omit<WatchScreenOptions, "region"> & {
    region?: Region | string;
  }): Promise<ScreenWatcher>;
  /**
   * High-level motion perception: stream -> region detection -> temporal object
   * association. Tracks expose stable IDs, paths, velocity, acceleration,
   * prediction and vertical-apex estimates in desktop coordinates.
   * @example
   * const tracker = await sdk.trackObjects({ region: arena, scale: 0.25, fps: 60 });
   * const seen = new Set<number>();
   * const observation = await tracker.nextFrame();
   * for (const object of observation?.objects ?? []) {
   *   if (seen.has(object.id)) continue; // one action per stable object
   *   seen.add(object.id);
   *   const target = object.apex?.point ?? object.predict(30);
   *   await sdk.clickAt(target.x, target.y);
   * }
   */
  trackObjects(opts?: Omit<ObjectTrackingOptions, "region"> & {
    region?: Region | string;
  }): Promise<ObjectTracker>;

  // ── action (no-op while paused; recorded in dry-run) ──
  clickAt(x: number, y: number, button?: "left" | "right" | "middle"): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  dragMouse(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts?: { button?: "left" | "right" | "middle"; duration?: number }
  ): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  /**
   * Press a key chord, e.g. `["command", "a"]`. `"mod"` is `command` on macOS and
   * `control` elsewhere; `lalt/ralt/lctrl/rctrl/lshift/rshift/lwin` map to the
   * base modifier. Applies to `key`, `hotkey`, `keyDown` and `keyUp`.
   */
  hotkey(keys: string[]): Promise<void>;
  /** Click at the CURRENT cursor position (AHK `Click()`). */
  click(button?: "left" | "right" | "middle"): Promise<void>;
  /**
   * Hold a key down. Held keys are tracked by the runner and released on every
   * exit path (complete, error, stop, duration), so a crash can't leave Alt stuck.
   */
  keyDown(key: string): Promise<void>;
  /** Release a key. Always allowed for a key this run is holding (even while paused). */
  keyUp(key: string): Promise<void>;
  /** Hold `keys` while `fn` runs; releases them (try/finally) afterwards. */
  withKeysHeld<T>(keys: string[], fn: () => T | Promise<T>): Promise<T>;
  /**
   * Is `key` down? `physical: true` queries the hardware state (ignores events
   * this process injected). Returns false (and logs one warning) when the native
   * core can't report key state.
   */
  keyState(key: string, opts?: { physical?: boolean }): Promise<boolean>;
  /** Text clipboard (native, with a CLI fallback). Writes obey pause/dry-run. */
  readonly clipboard: AutomationClipboard;
  /**
   * Copy the current selection and return its text (null on timeout). Snapshots
   * the clipboard, clears it, sends the chord, waits for text, and restores the
   * snapshot (when `restore`, the default).
   */
  copySelection(opts?: CopySelectionOptions): Promise<string | null>;
  /** Random integer in [min, max], inclusive (AHK `Random`). */
  random(min: number, max: number): number;
  /** Window helpers. */
  readonly window: {
    /** Is the focused window matching `match`? (case-insensitive) */
    isActive(match: WindowMatch): Promise<boolean>;
  };
  /**
   * Persistent JSON state at
   * `~/.knowhow/automations-data/<automationName>/<name>.json`.
   */
  store<T>(name: string, defaults: T): Store<T>;
  /** Minimal UI helpers (M0 fallbacks; native host UI arrives in M1/M2). */
  readonly ui: AutomationUi;
  /** Native GUI forms (host-backed; headless in-memory without a host). */
  readonly gui: AutomationGui;
  /** System-tray integration (no-ops unless a host is attached). */
  readonly tray: AutomationTray;
  /**
   * Global hotkeys. Requires the knowhow computer host (M1) or a pluggable
   * HotkeyProvider; otherwise `on` throws. Registered hotkeys keep the
   * automation alive.
   */
  readonly hotkeys: AutomationHotkeys;

  // ── lifetime (AHK "persistent" rule) ──
  /** Stay resident even with no hotkeys/timers/windows (until exit/stop). */
  keepAlive(): void;
  /** End the run now (runs onExit handlers, releases held keys). */
  exit(): void;
  /** Register cleanup that runs on every exit path (2 s cap per handler). */
  onExit(fn: () => void | Promise<void>): void;
  /** Resolves when the run is exiting (exit(), stop, duration, kill switch). */
  untilExit(): Promise<void>;
  /** Focus an app/window. Call before installing requiredWindow. */
  focus(match: string): Promise<boolean>;
  /** Select a pop-up/combo-box option without keyboard type-ahead. */
  selectAccessibilityOption(id: string, option: string): Promise<void>;
  /** Set a settable accessibility element value using a fresh discovered ID. */
  setAccessibilityValue(id: string, value: string): Promise<void>;
  /** Perform an allowlisted AX action (for example AXPress or AXShowMenu). */
  performAccessibilityAction(id: string, action: string): Promise<void>;

  // ── click-through visual debugging ──
  /** Replace native annotations. Suppressed in dry-run and while focus-gated. */
  showOverlay(primitives: OverlayPrimitive[]): Promise<void>;
  /** Clear annotations. This remains available while paused/stopped for cleanup. */
  clearOverlay(): Promise<void>;

  // ── durable state transition journals ──
  /**
   * Open evidence-backed state/action graphs. The registry is generic; game or
   * application state parsing remains automation-defined.
   */
  readonly worldlines: WorldlineRegistry;

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
    recognitionLevel?: "fast" | "accurate";
  }): Promise<OcrResult[]>;
  /** Immutable JSON parameters supplied by the caller for this run. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly ctl: AutomationControl;
  /**
   * Invoke any registered Knowhow tool by name. The same tools are also
   * installed as top-level functions in the automation scope, so either
   * `await sdk.callTool("prologQuery", args)` or `await prologQuery(args)` works.
   */
  callTool(toolName: string, parameters?: Record<string, unknown>): Promise<any>;

  // ── extension APIs ──
  /**
   * Access a registered automation SDK extension by name.
   * Throws a helpful error (listing available names) if the name is unknown.
   * Use sdk.extensions() to list all available extensions at runtime.
   */
  readonly ext: AutomationExtensions & Record<string, any>;
  /** List all registered extensions (name + description) for this run. */
  extensions(): { name: string; description: string }[];
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
    if (isAutomationPath(name)) {
      let p = path.resolve(name);
      if (!fs.existsSync(p) && fs.existsSync(p + ".ts")) p += ".ts";
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return undefined;
      const script = fs.readFileSync(p, "utf8");
      return {
        name: automationNameFromPath(p),
        script,
        doc: parseAutomationDoc(script),
        filePath: p,
        baseDir: path.dirname(p),
      };
    }
    const p = automationPath(name);
    if (fs.existsSync(p)) {
      const script = fs.readFileSync(p, "utf8");
      return { name, script, doc: parseAutomationDoc(script), filePath: p };
    }
    // Read old files during migration, but all new writes use plain .ts files.
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const legacy = path.join(STORE_DIR, `${safe}.automation.json`);
    if (fs.existsSync(legacy)) {
      const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
      return {
        name,
        script: parsed.script,
        doc: parseAutomationDoc(parsed.script || ""),
        filePath: legacy,
      };
    }
    // Finally, search extra dirs (./automations, config/env automationPaths).
    for (const dir of automationSearchDirs()) {
      const f = path.join(dir, `${safe}.ts`);
      if (fs.existsSync(f)) {
        const script = fs.readFileSync(f, "utf8");
        return { name, script, doc: parseAutomationDoc(script), filePath: path.resolve(f), baseDir: dir };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Load a constrained relative module used by another automation. */
function loadAutomationImportSafe(name: string): string | undefined {
  return makeImportLoader()(name);
}

/** Import loader rooted at `baseDir` (default: the .knowhow/automations store). */
export function makeImportLoader(baseDir?: string): (name: string) => string | undefined {
  return (name: string) => {
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/.test(name)) return undefined;
    try {
      const root = path.resolve(baseDir ?? STORE_DIR);
      const candidate = path.resolve(root, `${name}.ts`);
      if (!candidate.startsWith(root + path.sep) || !fs.existsSync(candidate)) return undefined;
      return fs.readFileSync(candidate, "utf8");
    } catch {
      return undefined;
    }
  };
}

export function listAutomations(): AutomationSpec[] {
  try {
    const names = new Set<string>();
    for (const dir of [STORE_DIR, ...automationSearchDirs()]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        // Helper/library files (`name.lib.ts`, `poecraft.logic.ts`: any extra dot
        // in the base name) are import-only and never listed or runnable.
        if (f.endsWith(".ts") && !f.slice(0, -3).includes(".")) names.add(f.slice(0, -3));
      }
    }
    return [...names]
      .map((n) => loadAutomationSafe(n) || null)
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

const SDK_IMPORT = /^\s*import\s*\{\s*sdk\s*\}\s*from\s*["']@tyvm\/knowhow-module-computer-use["']\s*;?\s*$/gm;

/**
 * Matches automation-to-automation import lines, e.g.:
 *   import { foo, bar as baz } from './my-helper';
 * The explicit `@automation/my-helper` form is also accepted.
 * Group 1: the specifiers string (e.g. "foo, bar as baz")
 * Group 2: the sibling automation name (e.g. "my-helper")
 */
const AUTOMATION_IMPORT =
  /^\s*import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["'](?:@automation\/|\.\/)([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*?(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*?)*)(?:\.ts)?["']\s*;?\s*$/gm;

/** Strip TypeScript-only syntax while preserving constrained ESM imports. */
function transpileAutomationSource(script: string): string {
  return ts.transpileModule(script, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
    reportDiagnostics: false,
  }).outputText;
}

/**
 * Strip TypeScript-only syntax from the main script body (type annotations,
 * generics, interfaces). Top-level `await` is preserved: the body is run as an
 * async function. `export` keywords are removed (nothing consumes them).
 */
export function transpileMainScript(script: string): string {
  const out = ts.transpileModule(script, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
      moduleDetection: ts.ModuleDetectionKind.Force,
    } as any,
    reportDiagnostics: false,
  }).outputText;
  return out
    .replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, "")
    .replace(/^export\s+(?=(async\s+function|function|class|const|let|var)\b)/gm, "");
}

function identifierAppears(code: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(code);
}

/**
 * Extract the set of named exports from an automation script body.
 * Supports:
 *   export function foo(...) { ... }
 *   export async function foo(...) { ... }
 *   export const foo = ...
 *   export { foo, bar }
 *   export { foo as bar }  (the alias becomes the external name)
 * Returns a map from exported name -> the code snippet that defines it,
 * ready for inlining into a consuming automation.
 *
 * @param allDeclarations When truthy, a second Map<string,string> to populate
 *   with ALL function/const declarations found in the script (exported or not).
 *   Used by resolveAutomationImports to resolve `export { localName }` refs.
 */
export function extractAutomationExports(
  script: string,
  allDeclarations?: Map<string, string>
): Map<string, string> {
  // Strip the SDK import and automation imports before extracting
  const stripped = script
    .replace(new RegExp(SDK_IMPORT.source, "gm"), "")
    .replace(new RegExp(AUTOMATION_IMPORT.source, "gm"), "");

  const exports = new Map<string, string>();
  // AST-based (not brace counting) so braces inside strings, regex literals
  // and template literals cannot confuse the extraction.
  const sf = ts.createSourceFile("automation.ts", stripped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const hasMod = (n: ts.Node, kind: ts.SyntaxKind) =>
    ((n as any).modifiers as ts.NodeArray<ts.ModifierLike> | undefined)?.some((m) => m.kind === kind) ?? false;
  const textOf = (n: ts.Node) => n.getText(sf).replace(/^export\s+(default\s+)?/, "");

  for (const stmt of sf.statements) {
    const exported = hasMod(stmt, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const decl = textOf(stmt);
      if (exported) exports.set(stmt.name.text, decl);
      allDeclarations?.set(stmt.name.text, decl);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const decl = textOf(stmt);
      if (exported) exports.set(stmt.name.text, decl);
      allDeclarations?.set(stmt.name.text, decl);
    } else if (ts.isVariableStatement(stmt)) {
      let decl = textOf(stmt);
      if (!exported) decl = decl.trimEnd().replace(/;?\s*$/, ";");
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (exported) exports.set(d.name.text, decl);
        allDeclarations?.set(d.name.text, decl);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        const exportedName = el.name.text;
        const localName = (el.propertyName ?? el.name).text;
        if (localName !== exportedName) {
          // The consumer needs the exported name; emit a const alias
          exports.set(exportedName, `const ${exportedName} = ${localName};`);
        } else {
          // Local-name reference; the caller resolves the definition.
          exports.set(exportedName, `/* ref:${localName} */`);
        }
      }
    }
  }

  return exports;
}

/**
 * Resolve and inline `import { x, y as z } from './name'` imports (the
 * `@automation/name` spelling is retained as an explicit alias)
 * in an automation script. Returns the script with those imports replaced by
 * the inlined exported code from the sibling automation. Recursive (nested
 * imports are resolved depth-first). Detects cycles and missing exports.
 *
 * @param script    The raw source of the automation being prepared (SDK import already stripped).
 * @param name      The name of the automation being prepared (for cycle detection).
 * @param ancestors The chain of automation names already being resolved (cycle guard).
 * @param loader    Optional override for loading sibling automations (for tests).
 */
export function resolveAutomationImports(
  script: string,
  name: string,
  ancestors: ReadonlySet<string> = new Set(),
  loader: (n: string) => string | undefined = loadAutomationImportSafe
): string {
  const importLines: Array<{
    line: string;
    sibling: string;
    specifiers: Array<{ local: string; alias: string }>;
  }> = [];

  // Collect all constrained sibling-automation imports.
  const re = new RegExp(AUTOMATION_IMPORT.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const specStr = m[1];
    const sibling = m[2];
    const typeOnly = /^\s*import\s+type\b/.test(m[0]);
    const specifiers = (typeOnly ? "" : specStr)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => !s.startsWith("type "))
      .filter(Boolean)
      .map((s) => {
        const parts = s.split(/\s+as\s+/);
        return { local: parts[0].trim(), alias: parts[1]?.trim() ?? parts[0].trim() };
      });
    importLines.push({ line: m[0], sibling, specifiers });
  }

  if (!importLines.length) return script;

  let result = script;
  const inlinedPrologue: string[] = [];

  for (const { line, sibling, specifiers } of importLines) {
    if (ancestors.has(sibling)) {
      throw new Error(
        `Automation import cycle detected: ${[...ancestors, name, sibling].join(" → ")}`
      );
    }
    const siblingScript = loader(sibling);
    if (siblingScript === undefined) {
      throw new Error(
        `Automation "${name}" imports from "@automation/${sibling}", but no such automation exists.`
      );
    }

    // Recursively resolve the sibling's own imports first (strip SDK import first)
    const nextAncestors = new Set([...ancestors, name]);
    const resolvedSibling = transpileAutomationSource(resolveAutomationImports(
      siblingScript.replace(new RegExp(SDK_IMPORT.source, "gm"), ""),
      sibling,
      nextAncestors,
      loader
    ));

    // Extract exports from the fully-resolved sibling.
    // Also collect ALL declarations (exported or not) so that:
    //  - `export { localFn }` ref entries can be resolved to their definition
    //  - nested-imported helpers used inside exported functions are available
    const allDecls = new Map<string, string>();
    const siblingExports = extractAutomationExports(resolvedSibling, allDecls);

    // Return dependencies before their consumer, recursively. This includes
    // declarations brought in by nested automation imports as well as private
    // helpers in the sibling itself.
    const dependenciesOf = (rootName: string, rootCode: string): string[] => {
      const emitted = new Set<string>([rootName]);
      const ordered: string[] = [];
      const visit = (code: string) => {
        for (const [declName, declCode] of allDecls) {
          if (emitted.has(declName) || !identifierAppears(code, declName)) continue;
          emitted.add(declName);
          visit(declCode);
          ordered.push(declCode);
        }
      };
      visit(rootCode);
      return ordered;
    };

    for (const { local, alias } of specifiers) {
      if (!siblingExports.has(local)) {
        // Type-only exports (interface/type) vanish at transpile time and need no binding.
        if (new RegExp(`\\b(?:interface|type)\\s+${local.replace(/[$]/g, "\\$")}\\b`).test(siblingScript)) continue;
        throw new Error(
          `Automation "${name}" tries to import "${local}" from "@automation/${sibling}", ` +
          `but that export does not exist. Available exports: ${[...siblingExports.keys()].join(", ") || "(none)"}.`
        );
      }
      const exportCode = siblingExports.get(local)!;
      if (exportCode.startsWith("/* ref:")) {
        // The export is a re-export list entry. Look up the underlying definition
        // in both exported names and all declarations (catches non-exported locals).
        const refName = exportCode.slice("/* ref:".length, -" */".length).trim();
        // Prefer allDecls (actual definition) over siblingExports (which may
        // itself be another /* ref:... */ placeholder) to avoid infinite regress.
        const refDecl = allDecls.get(refName) ?? siblingExports.get(refName);
        if (refDecl) {
          inlinedPrologue.push(...dependenciesOf(refName, refDecl));
          inlinedPrologue.push(refDecl);
          if (alias !== refName) {
            inlinedPrologue.push(`const ${alias} = ${refName};`);
          }
        } else {
          throw new Error(
            `Automation "${name}" imports "${local}" from "@automation/${sibling}", ` +
            `but its definition could not be extracted. Use "export function" or "export const" for reliably importable exports.`
          );
        }
      } else {
        inlinedPrologue.push(...dependenciesOf(local, exportCode));
        inlinedPrologue.push(exportCode);
        // If the caller uses a different alias, add an alias const binding
        if (alias !== local) {
          inlinedPrologue.push(`const ${alias} = ${local};`);
        }
      }
    }

    // Remove the import line from the script
    result = result.replace(line, "");
  }

  // Prepend all inlined definitions (deduplicated by content to handle diamond deps)
  const seen = new Set<string>();
  const unique = inlinedPrologue.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
  if (unique.length) {
    result = unique.join("\n") + "\n" + result;
  }
  return result;
}

/** Remove the one editor-only import supported by automation source files. */
export function prepareAutomationScript(script: string, baseDir?: string): string {
  return resolveAutomationImports(
    script.replace(SDK_IMPORT, ""),
    "__prepare__",
    new Set(),
    baseDir ? makeImportLoader(baseDir) : loadAutomationImportSafe
  );
}

/**
 * Automations are TRUSTED code: they exist to drive the whole desktop, and they
 * run in-process with the same privileges as the CLI. There used to be a
 * forbidden-token blacklist here (require/process/fetch/eval/...), but a token
 * blacklist is not a security boundary (e.g. `({}).constructor.constructor`)
 * and only gave a false sense of safety. Only run automations you trust.
 *
 * This now only rejects scripts that don't parse, so authoring errors surface
 * at save time instead of at run time.
 */
export function validateScript(script: string): void {
  script = script.replace(SDK_IMPORT, "").replace(new RegExp(AUTOMATION_IMPORT.source, "gm"), "");
  // Static imports can't run inside the injected async function body (that's a
  // grammar check transpileModule doesn't report), so reject them explicitly.
  const sf = ts.createSourceFile("automation.ts", script, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const staticImport = sf.statements.find((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
  if (staticImport) {
    throw new Error(
      `Automation script has a syntax error: static import "${staticImport.getText(sf).slice(0, 80)}" is not supported. ` +
        `Only the SDK import and sibling automation imports ('./name' or '@automation/name') are allowed.`
    );
  }
  // Wrap as an async function body, matching how the runner executes it.
  const wrapped = `(async () => {\n${script}\n})();`;
  const out = ts.transpileModule(wrapped, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const msg = ts.flattenDiagnosticMessageText(errors[0].messageText, "\n");
    throw new Error(`Automation script has a syntax error: ${msg}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as {
  new (...args: string[]): (...a: any[]) => Promise<any>;
};

export interface RunOptions {
  maxDurationMs?: number;
  /** Immutable JSON-compatible values exposed to the script as sdk.params. */
  params?: Record<string, unknown>;
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
  /** Registered Knowhow tools exposed to the authored automation. */
  toolsService?: ToolsService;
  /** ExtensionsService to resolve automation-sdk extensions from. Gracefully absent. */
  extensions?: ExtensionsService;
  /** Hotkey provider for this run (defaults to the one set via setHotkeyProvider). */
  hotkeyProvider?: HotkeyProvider;
  /** Called (best effort) whenever the set of keys this run holds changes. */
  onHeldKeysChange?: (keys: string[]) => void;
  /** Tray bridge supplied by the host worker; absent = sdk.tray is a no-op. */
  tray?: TrayBridge;
  /**
   * GUI backend (forms/dialogs/tooltips). The host worker passes
   * `HostHotkeyProvider.gui()`; absent = headless in-memory forms and local
   * dialog fallbacks.
   */
  gui?: GuiBackend;
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
  private artifacts: ScreenFrameArtifact[] = [];
  private gateTimer: NodeJS.Timeout | null = null;
  private readonly artifactRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  private static readonly MAX_FRAME_ARTIFACTS = 100;
  private durationTimer: NodeJS.Timeout | null = null;
  /** True once a non-empty required-window gate has been configured. */
  private everGatedWindow = false;
  /** Resolved max run duration (ms). Set at the start of run(). */
  maxDurationMs = DEFAULT_AUTOMATION_DURATION_MS;
  private streamDisposers = new Set<() => void>();
  private stopReason: "duration" | "manual" | "completed" | "error" | null =
    null;
  private disposeCallbacks: Array<() => void | Promise<void>> = [];
  private extApis: Map<string, unknown> = new Map();

  // ── lifetime (plan §6.2) ──
  /** Active lifetime holders (hotkeys, timers, watchers, keepAlive). */
  private retainers = new Map<symbol, string>();
  private lifetimeWake: (() => void) | null = null;
  private exitWaiters: Array<() => void> = [];
  private exitHandlers: Array<() => void | Promise<void>> = [];
  private keepAliveToken: symbol | null = null;
  // ── held keys (released on every exit path) ──
  private heldKeys = new Set<string>();
  // ── hotkeys registered by this run ──
  private hotkeyIds = new Map<string, HotkeyProvider>();
  private hotkeySeq = 0;
  private menuSeq = 0;
  private warnedKeyState = false;
  private tooltipTimer: NodeJS.Timeout | null = null;
  private guiService: GuiService | null = null;

  /** The backend `sdk.gui` uses (RunOptions.gui or a per-run headless one). */
  get guiBackend(): GuiBackend {
    return this.ensureGui().backend;
  }

  private ensureGui(): GuiService {
    if (!this.guiService) {
      const backend = this.opts.gui ?? new HeadlessGuiBackend((d) => this.emit(d));
      this.guiService = new GuiService(backend, {
        log: (d) => this.emit(d),
        retain: () => this.retain("gui"),
        release: (t) => this.release(t),
        exit: () => this.requestStop("completed"),
      });
    }
    return this.guiService;
  }

  readonly ctl: AutomationControl = {
    paused: false,
    stopped: false,
    requiredWindow: undefined,
    stop: () => this.requestStop("manual"),
  };

  /** Mark the run stopped (first reason wins), wake lifetime + untilExit waiters. */
  private requestStop(reason: "duration" | "manual" | "completed"): void {
    if (!this.ctl.stopped) this.stopReason = this.stopReason ?? reason;
    this.ctl.stopped = true;
    this.wakeLifetime();
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
  }

  private wakeLifetime(): void {
    const wake = this.lifetimeWake;
    this.lifetimeWake = null;
    if (wake) wake();
  }

  /** Ref-count tracker: the run stays alive while any token is held. */
  retain(reason: string): symbol {
    const token = Symbol(reason);
    this.retainers.set(token, reason);
    return token;
  }

  release(token: symbol): void {
    if (this.retainers.delete(token)) this.wakeLifetime();
  }

  /** Number of active lifetime holders (exposed for tests/diagnostics). */
  get retainCount(): number {
    return this.retainers.size;
  }

  /** Keys currently held by this run (exposed for tests/diagnostics). */
  heldKeyNames(): string[] {
    return [...this.heldKeys];
  }

  private notifyHeld(): void {
    try {
      this.opts.onHeldKeysChange?.([...this.heldKeys]);
    } catch {
      /* host reporting is best effort */
    }
  }

  /** External (host) pause/resume; keeps pausedMs accounting consistent. */
  setPaused(paused: boolean, reason = "host"): void {
    if (this.ctl.stopped || this.ctl.paused === paused) return;
    this.ctl.paused = paused;
    if (paused) {
      this.pauseStartedAt = this.now();
      this.emit({ paused: reason });
    } else {
      if (this.pauseStartedAt) {
        this.pausedAccumMs += this.now() - this.pauseStartedAt;
        this.pauseStartedAt = 0;
      }
      this.emit({ resumed: true, reason });
    }
  }

  private untilStopped(): Promise<void> {
    if (this.ctl.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => this.exitWaiters.push(resolve));
  }

  /** Wait until the body is done AND nothing retains the run (or it is stopped). */
  private async waitForLifetimeEnd(): Promise<void> {
    while (!this.ctl.stopped && this.retainers.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        if (timer.unref) timer.unref();
        this.lifetimeWake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Release every key this run is still holding (best effort, any state). */
  private async releaseHeldKeys(): Promise<void> {
    const keys = [...this.heldKeys];
    this.heldKeys.clear();
    if (keys.length) this.notifyHeld();
    for (const key of keys) {
      try {
        await this.svc.keyUp(key);
        this.actions.push({ t: this.elapsed(), kind: "keyUp", text: key, suppressed: false });
      } catch (e: any) {
        this.emit({ keyReleaseError: key, error: e?.message ?? String(e) });
      }
    }
  }

  private async runExitHandlers(): Promise<void> {
    const handlers = this.exitHandlers;
    this.exitHandlers = [];
    for (const fn of handlers) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => fn()),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              this.emit({ onExit: "timeout", afterMs: 2000 });
              resolve();
            }, 2000);
          }),
        ]);
      } catch (e: any) {
        this.emit({ onExitError: e?.message ?? String(e) });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  private async unregisterHotkeys(): Promise<void> {
    const entries = [...this.hotkeyIds.entries()];
    this.hotkeyIds.clear();
    for (const [id, provider] of entries) {
      try {
        await provider.unregister(id);
      } catch (e: any) {
        this.emit({ hotkeyUnregisterError: id, error: e?.message ?? String(e) });
      }
    }
  }

  /** Ask the host for a native dialog; null = unavailable/failed (caller falls back). */
  private async hostDialog(
    kind: "alert" | "confirm" | "prompt",
    message: string,
    title?: string,
    def?: string
  ): Promise<import("./gui/types").DialogResult | null> {
    const gui = this.opts.gui;
    if (!gui?.dialog) return null;
    try {
      return await gui.dialog({
        kind,
        title: title ?? this.spec.name,
        message: String(message ?? ""),
        default: def ?? "",
      });
    } catch (e: any) {
      this.emit({ uiFallback: kind, error: e?.message ?? String(e) });
      return null;
    }
  }

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
    active: { title: string; app?: string; exe?: string; bundleId?: string } | null,
    match?: WindowMatch
  ): boolean {
    // Identity selectors (app/exe/bundleId) are alternatives; titleIncludes is
    // ANDed with them. See windowMatch.ts.
    return windowMatches(active, match);
  }

  private async pollGate(): Promise<void> {
    if (this.ctl.stopped) return;
    if (!this.ctl.requiredWindow) return;
    let active: { title: string; app?: string; exe?: string; bundleId?: string } | null = null;
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

  private async recordFrame(
    frame: ScreenFrame,
    label: string,
    options: LogScreenActionOptions = {}
  ): Promise<ScreenFrameArtifact | null> {
    const captureAllowed = !this.ctl.stopped && !this.ctl.paused &&
      (!this.opts.dryRun || options.captureInDryRun === true);
    if (!captureAllowed) {
      this.emit({
        frameArtifact: "suppressed",
        label,
        reason: this.ctl.paused ? "window-focus-lost" :
          this.opts.dryRun ? "dry-run" : "automation-stopped",
      });
      return null;
    }
    if (this.artifacts.length >= AutomationRunner.MAX_FRAME_ARTIFACTS) {
      throw new Error(
        `ScreenWatcher.logAction is limited to ${AutomationRunner.MAX_FRAME_ARTIFACTS} frame artifacts per run`
      );
    }
    if (!frame?.data || !Buffer.isBuffer(frame.data)) {
      throw new Error("ScreenWatcher.logAction received an invalid frame");
    }

    const format = options.format ?? "png";
    const safeName = this.spec.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "automation";
    const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "action";
    const id = `${String(this.artifacts.length + 1).padStart(3, "0")}-${safeLabel}`;
    const dir = path.resolve(
      process.cwd(), ".knowhow", "artifacts", "automations", safeName, this.artifactRunId
    );
    fs.mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `${id}.${format === "jpeg" ? "jpg" : "png"}`);
    // Encode the existing stream buffer. Taking another screenshot here could
    // capture a later animation phase and defeats the purpose of frame evidence.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    await sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    })[format]().toFile(artifactPath);

    const actionIndex = this.actions.length ? this.actions.length - 1 : undefined;
    const action = actionIndex === undefined ? undefined : this.actions[actionIndex];
    const artifact: ScreenFrameArtifact = {
      id,
      path: artifactPath,
      label,
      t: this.elapsed(),
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      region: { ...frame.region },
      width: frame.width,
      height: frame.height,
      scaleX: frame.scaleX,
      scaleY: frame.scaleY,
      format,
      actionIndex,
      actionKind: action?.kind,
    };
    this.artifacts.push(artifact);
    this.emit({ frameArtifact: artifact });
    return artifact;
  }

  private async callTool(
    toolName: string,
    parameters: Record<string, unknown> = {}
  ): Promise<any> {
    if (typeof toolName !== "string" || !toolName.trim()) {
      throw new Error("sdk.callTool requires a non-empty tool name.");
    }
    const tools = this.opts.toolsService;
    // The standalone `computer run-automation` command intentionally starts
    // before the full chat tool graph. Keep its core symbolic planner usable
    // directly, just as Worldlines is available directly to this runner.
    if (!tools && toolName === "prologFindPlan") {
      this.emit({ toolCall: "start", toolName });
      try {
        const p: any = parameters;
        const result = await prologFindPlan(
          p.program, p.maxPlanLength, p.initialPredicate, p.transitionPredicate,
          p.goalPredicate, p.maxAnswers, p.inferenceLimit, p.timeoutMs,
          p.minPlanLength, p.preferredActions
        );
        this.emit({ toolCall: "success", toolName });
        return result;
      } catch (error) {
        this.emit({
          toolCall: "error", toolName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    if (!tools) {
      throw new Error("Knowhow tools are not available in this automation runner.");
    }
    // Match the script module's recursion guard. An automation may reason with
    // tools, but it must not open another script execution environment.
    if (toolName === "executeScript") {
      throw new Error("Nested script execution is not allowed in automations.");
    }

    this.emit({ toolCall: "start", toolName });
    const result = await tools.callTool(
      {
        id: `automation-tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: "function",
        function: { name: toolName, arguments: JSON.stringify(parameters ?? {}) },
      },
      tools.getFunctionNames()
    );
    const errorMessage = result?.toolMessages?.find((message: any) => message.name === "error");
    if (errorMessage) {
      this.emit({ toolCall: "error", toolName, error: errorMessage.content });
      throw new Error(errorMessage.content || `Tool '${toolName}' failed`);
    }
    this.emit({ toolCall: "success", toolName });
    return result?.functionResp;
  }

  private async configureRequiredWindow(match?: WindowMatch): Promise<void> {
    this.ctl.requiredWindow = match;
    if (match && hasWindowSelectors(match)) {
      this.everGatedWindow = true;
    }
    if (this.gateTimer) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
    if (!match || !hasWindowSelectors(match)) {
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

  private buildSDK(extApis: Map<string, unknown>): AutomationSDK {
    const svc = this.svc;
    const self = this;
    const freezeJson = (value: any): any => {
      if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
      if (value && typeof value === "object") {
        return Object.freeze(Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, freezeJson(child)])
        ));
      }
      return value;
    };
    const params = freezeJson(this.opts.params ?? {});
    const clickSettleMs = Math.max(0, this.opts.clickSettleMs ?? 40);
    const sdk: AutomationSDK = {
      params,
      worldlines,
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
        const lifetimeToken = self.retain("runEvery");
        try {
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
              self.requestStop("duration");
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
        } finally {
          self.release(lifetimeToken);
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
          scale: o.scale,
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
      pixelColors: (points) => svc.pixelColors(points),
      analyzeGrid: (frame, o) => analyzeGridFrame(frame, o),
      sharp: (input, options = {}) => {
        if (input && typeof input === "object" && "data" in input &&
            "width" in input && "height" in input) {
          const frame = input as ScreenFrame;
          if (!Buffer.isBuffer(frame.data) || frame.width < 1 || frame.height < 1) {
            throw new Error("sdk.sharp received an invalid ScreenFrame");
          }
          return sharpFactory(frame.data, {
            ...options,
            raw: { width: frame.width, height: frame.height, channels: 4 },
          });
        }
        if (!Buffer.isBuffer(input)) {
          throw new Error("sdk.sharp only accepts an in-memory Buffer or ScreenFrame");
        }
        return sharpFactory(input, options);
      },

      readText: (o = {}) => svc.readText(o as ReadTextOptions),

      watchScreen: async (o = {}) => {
        const driver = await svc.getDriver();
        if (!(driver instanceof RustCoreDriver)) {
          throw new Error("sdk.watchScreen requires the native Rust computer driver");
        }
        const resolved = await resolveRegionAsync(o.region as any, () => svc.getActiveWindow());
        const region = resolved ?? { x: 0, y: 0, ...(await svc.screenSize()) };
        let watcher: ScreenWatcher;
        try {
          watcher = createScreenWatcher(
            driver,
            { ...o, region },
            (frame, label, options) => self.recordFrame(frame, label, options),
            () => !self.opts.dryRun
          );
        } catch (streamError) {
          // ScreenCaptureKit streaming can be unavailable to a freshly spawned
          // CLI process even when one-shot capture is permitted. Preserve the
          // watcher contract with demand-driven screenshots so evidence-backed
          // automations still run (at a lower frame rate) via `knowhow computer`.
          self.emit({ screenWatcher: "polling-fallback", error: String(streamError) });
          let sequence = 0;
          let last: ScreenFrame | null = null;
          let stopped = false;
          const capture = async (): Promise<ScreenFrame | null> => {
            if (stopped) return null;
            const encoded = await svc.screenshot({ region });
            const decoded = await sharpFactory(encoded).ensureAlpha().raw()
              .toBuffer({ resolveWithObject: true });
            last = {
              data: decoded.data,
              width: decoded.info.width,
              height: decoded.info.height,
              sequence: ++sequence,
              capturedAt: Date.now(),
              receivedAt: Date.now(),
              region: { ...region },
              scaleX: decoded.info.width / region.width,
              scaleY: decoded.info.height / region.height,
            };
            return last;
          };
          watcher = {
            region: { ...region },
            latest: (afterSequence = 0) => last && last.sequence > afterSequence ? last : null,
            nextFrame: async (afterSequence = 0) => {
              const frame = await capture();
              return frame && frame.sequence > afterSequence ? frame : null;
            },
            logAction: async (label, options = {}) => {
              const frame = options.frame ?? last ?? await capture();
              if (!frame) throw new Error("ScreenWatcher.logAction has no frame to record");
              return self.recordFrame(frame, label, options);
            },
            logTransition: async (label, options: any) => {
              if (!options?.worldline || !options.transition) {
                throw new Error("ScreenWatcher.logTransition requires a worldline and transition");
              }
              const frame = options.frame ?? last ?? await capture();
              if (!frame) throw new Error("ScreenWatcher.logTransition has no frame to record");
              const artifact = await self.recordFrame(frame, label, options);
              if (!artifact) return null;
              if (self.opts.dryRun) return { artifact, transition: null };
              const recorded = options.worldline.recordTransition({
                ...options.transition,
                evidence: [
                  ...(Array.isArray(options.transition.evidence) ? options.transition.evidence : []),
                  { kind: "computer-use/screen-frame", path: artifact.path,
                    mimeType: artifact.format === "jpeg" ? "image/jpeg" : "image/png",
                    metadata: { ...artifact } },
                ],
              });
              return { artifact, transition: recorded };
            },
            stop: () => { stopped = true; last = null; },
          };
        }
        const stop = watcher.stop.bind(watcher);
        const watchToken = self.retain("watchScreen");
        const dispose = () => {
          stop();
          self.streamDisposers.delete(dispose);
          self.release(watchToken);
        };
        watcher.stop = dispose;
        self.streamDisposers.add(dispose);
        return watcher;
      },

      trackObjects: async (o = {}) => {
        const driver = await svc.getDriver();
        if (!(driver instanceof RustCoreDriver)) {
          throw new Error("sdk.trackObjects requires the native Rust computer driver");
        }
        const resolved = await resolveRegionAsync(o.region as any, () => svc.getActiveWindow());
        const region = resolved ?? { x: 0, y: 0, ...(await svc.screenSize()) };
        const watcher = createScreenWatcher(driver, { ...o, region });
        const tracker = createObjectTracker(watcher, { ...o, region });
        const stop = tracker.stop.bind(tracker);
        const dispose = () => { stop(); self.streamDisposers.delete(dispose); };
        tracker.stop = dispose;
        self.streamDisposers.add(dispose);
        return tracker;
      },

      showOverlay: async (primitives) => {
        if (!self.canAct()) return;
        await svc.showOverlay(primitives);
      },
      clearOverlay: () => svc.clearOverlay(),

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

      dragMouse: async (fromX, fromY, toX, toY, opts = {}) => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "dragMouse",
          x: fromX,
          y: fromY,
          x2: toX,
          y2: toY,
          button: opts.button ?? "left",
          duration: opts.duration,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.drag(
          { x: fromX, y: fromY },
          { x: toX, y: toY },
          opts
        );
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
        await svc.pressKey(normalizeKeyName(name));
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
        await svc.hotkey(...normalizeKeyNames(keys));
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

      click: async (button = "left") => {
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "click",
          button,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        await svc.click(button);
      },

      keyDown: async (key) => {
        const k = normalizeKeyName(key);
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "keyDown",
          text: k,
          suppressed: !self.canAct(),
        };
        self.actions.push(act);
        if (!self.canAct()) return;
        // Track BEFORE injecting: releasing a key that never went down is harmless,
        // while a missed release would leave it stuck.
        self.heldKeys.add(k);
        self.notifyHeld();
        await svc.keyDown(k);
      },

      keyUp: async (key) => {
        const k = normalizeKeyName(key);
        // Releasing a key this run holds is always allowed (even while paused or
        // stopped) so a focus-loss pause can never leave a modifier stuck.
        const allowed = self.canAct() || self.heldKeys.has(k);
        const act: AutomationAction = {
          t: self.elapsed(),
          kind: "keyUp",
          text: k,
          suppressed: !allowed,
        };
        self.actions.push(act);
        if (!allowed) return;
        self.heldKeys.delete(k);
        await svc.keyUp(k);
        self.notifyHeld();
      },

      withKeysHeld: async (keys, fn) => {
        const pressed: string[] = [];
        try {
          for (const key of keys) {
            await sdk.keyDown(key);
            pressed.push(key);
          }
          return await fn();
        } finally {
          for (const key of pressed.reverse()) {
            try {
              await sdk.keyUp(key);
            } catch (e: any) {
              self.emit({ keyReleaseError: key, error: e?.message ?? String(e) });
            }
          }
        }
      },

      keyState: async (key, opts = {}) => {
        const fn = (svc as any).keyState;
        let state: boolean | null = null;
        if (typeof fn === "function") {
          state = await fn.call(svc, normalizeKeyName(key), !!opts.physical);
        }
        if (state === null) {
          if (!self.warnedKeyState) {
            self.warnedKeyState = true;
            self.emit({ warning: "sdk.keyState is unsupported by this native core build; returning false" });
          }
          return false;
        }
        return !!state;
      },

      clipboard: (() => {
        const cb = () => {
          const c = (svc as any).clipboard;
          if (!c) throw new Error("Clipboard is not available from this computer service.");
          return c as import("./clipboard").ClipboardService;
        };
        const write = async (kind: "clipboardWrite", text: string, fn: () => Promise<void>) => {
          self.actions.push({
            t: self.elapsed(),
            kind,
            text,
            suppressed: !self.canAct(),
          });
          if (!self.canAct()) return;
          await fn();
        };
        return {
          readText: () => cb().readText(),
          writeText: (text: string) => write("clipboardWrite", text, () => cb().writeText(text)),
          snapshot: () => cb().snapshot(),
          restore: (snap: ClipboardSnapshot) =>
            write("clipboardWrite", snap?.text ?? "", () => cb().restore(snap)),
          waitForChange: (o?: { timeoutMs?: number }) => cb().waitForChange(o),
        };
      })(),

      copySelection: async (o = {}) => {
        const chord = o.chord ?? ["mod", "c"];
        self.actions.push({
          t: self.elapsed(),
          kind: "copySelection",
          text: chord.join("+"),
          suppressed: !self.canAct(),
        });
        if (!self.canAct()) return null;
        const c = (svc as any).clipboard as import("./clipboard").ClipboardService | undefined;
        if (!c) throw new Error("Clipboard is not available from this computer service.");
        return c.copySelection(o, async (keys) => {
          if (!self.canAct()) return;
          await svc.hotkey(...normalizeKeyNames(keys));
        });
      },

      random: (min, max) => {
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          throw new Error("sdk.random(min, max) requires finite numbers.");
        }
        const lo = Math.ceil(Math.min(min, max));
        const hi = Math.floor(Math.max(min, max));
        return lo + Math.floor(Math.random() * (hi - lo + 1));
      },

      window: {
        isActive: async (match) => windowMatches(await svc.getActiveWindow(), match),
      },

      store: <T>(name: string, defaults: T): Store<T> =>
        createStore<T>(self.spec.name, name, defaults, {
          persist: () => !self.opts.dryRun,
        }),

      ui: {
        beep: async (o = {}) => {
          if (!self.canAct()) return;
          const freq = o.freq ?? 1000;
          const ms = o.ms ?? 150;
          if (typeof (svc as any).beep === "function") await (svc as any).beep(freq, ms);
          else self.emit({ ui: "beep", freq, ms });
        },
        tooltip: async (text, o = {}) => {
          if (!self.canAct()) return;
          const ms = o.ms ?? 1500;
          const hostGui = self.opts.gui;
          if (hostGui?.tooltip) {
            try {
              await hostGui.tooltip({ text: String(text ?? ""), ms, x: null, y: null });
              return;
            } catch (e: any) {
              self.emit({ uiFallback: "tooltip", error: e?.message ?? String(e) });
            }
          }
          if (process.platform === "darwin" && typeof (svc as any).showOverlay === "function") {
            try {
              const pos = await svc.mousePosition();
              await svc.showOverlay([
                { kind: "text", x: pos.x + 16, y: pos.y + 20, text, fontSize: 14, color: "#ffffff" },
              ]);
              if (self.tooltipTimer) clearTimeout(self.tooltipTimer);
              self.tooltipTimer = setTimeout(() => {
                self.tooltipTimer = null;
                svc.clearOverlay().catch(() => {});
              }, ms);
              if (self.tooltipTimer.unref) self.tooltipTimer.unref();
              return;
            } catch {
              /* fall through to logging */
            }
          }
          self.emit({ tooltip: text, ms });
        },
        // Native host dialogs when attached; OS shell-out fallback otherwise
        // (or when the host reports an error, e.g. unsupported platform).
        alert: async (message, o = {}) => {
          if (self.opts.dryRun) return self.emit({ ui: "alert", message });
          const r = await self.hostDialog("alert", message, o.title);
          if (r) return;
          await uiAlert(message, { title: o.title });
        },
        confirm: async (message, o = {}) => {
          if (self.opts.dryRun) {
            self.emit({ ui: "confirm", message });
            return false;
          }
          const r = await self.hostDialog("confirm", message, o.title);
          if (r) return r.button === "yes" || r.button === "ok";
          return uiConfirm(message, { title: o.title });
        },
        prompt: async (message, o = {}) => {
          const opts = typeof o === "string" ? { default: o } : o ?? {};
          if (self.opts.dryRun) {
            self.emit({ ui: "prompt", message });
            return null;
          }
          const r = await self.hostDialog("prompt", message, opts.title, opts.default);
          if (r) return r.button === "ok" ? r.value ?? "" : null;
          return uiPrompt(message, opts.default ?? "", { title: opts.title });
        },
      },

      gui: {
        form: (spec: WindowSpec) => self.ensureGui().form(spec),
      },

      tray: {
        setStatus: (text) => {
          try {
            self.opts.tray?.setStatus(String(text ?? ""));
          } catch {
            /* ignore */
          }
        },
        addMenuItem: (label, fn) => {
          const id = `${self.spec.name}:menu-${++self.menuSeq}`;
          try {
            self.opts.tray?.addMenuItem(id, String(label), fn);
          } catch {
            /* ignore */
          }
          return id;
        },
      },

      hotkeys: (() => {
        const tokens = new Map<string, symbol>();
        return {
          on: (spec, fn, opts = {}) => {
            if (typeof fn !== "function") {
              throw new Error("sdk.hotkeys.on(spec, fn, opts) requires a function.");
            }
            const parsed = parseHotkeySpec(spec);
            if (isKillSwitchSpec(parsed)) {
              throw new Error(
                `Hotkey "${spec}" is reserved as the global kill switch (${getKillSwitch()}) and cannot be registered by automations.`
              );
            }
            const provider = self.opts.hotkeyProvider ?? getHotkeyProvider();
            if (!provider) throw new Error(HOTKEYS_UNAVAILABLE_MESSAGE);
            const options: HotkeyOptions = {
              anyModifiers: false,
              consume: true,
              noRepeat: false,
              concurrency: "parallel",
              ...opts,
            };
            const id = `${self.spec.name}:hotkey-${++self.hotkeySeq}`;
            const onTrigger = createHotkeyTrigger(fn, options, {
              checkWhen: async () => windowMatches(await svc.getActiveWindow(), options.when),
              canRun: () => !self.ctl.stopped && !self.ctl.paused,
              onError: (e: any) => self.emit({ hotkeyError: spec, error: e?.message ?? String(e) }),
            });
            self.hotkeyIds.set(id, provider);
            tokens.set(id, self.retain(`hotkey:${spec}`));
            Promise.resolve(provider.register({ id, spec, parsed, options, onTrigger })).catch(
              (e: any) => self.emit({ hotkeyRegisterError: spec, error: e?.message ?? String(e) })
            );
            return id;
          },
          off: (id) => {
            const provider = self.hotkeyIds.get(id);
            self.hotkeyIds.delete(id);
            const token = tokens.get(id);
            tokens.delete(id);
            if (provider) {
              Promise.resolve(provider.unregister(id)).catch(() => {});
            }
            if (token) self.release(token);
          },
          waitRelease: async (key) => {
            const provider = self.opts.hotkeyProvider ?? getHotkeyProvider();
            if (provider?.waitRelease) return provider.waitRelease(key);
            const fn = (svc as any).keyState;
            if (typeof fn !== "function") return;
            while (!self.ctl.stopped) {
              const down = await fn.call(svc, normalizeKeyName(key), true);
              if (!down) return;
              await new Promise((r) => setTimeout(r, 15));
            }
          },
        };
      })(),

      keepAlive: () => {
        if (!self.keepAliveToken) self.keepAliveToken = self.retain("keepAlive");
      },
      exit: () => self.requestStop("completed"),
      onExit: (fn) => {
        if (typeof fn !== "function") throw new Error("sdk.onExit(fn) requires a function.");
        self.exitHandlers.push(fn);
      },
      untilExit: () => self.untilStopped(),

      sleep: (ms) =>
        new Promise((resolve) => {
          const capped = Math.max(0, Math.min(60000, ms || 0));
          setTimeout(resolve, capped);
        }),

      now: () => self.now(),
      elapsed: () => self.elapsed(),
      log: (data) => self.emit(data),
      callTool: (toolName, parameters = {}) => self.callTool(toolName, parameters),
      ext: buildExtProxy(extApis),
      extensions: () => {
        const exts = (self.opts.extensions?.list(AUTOMATION_SDK_EXTENSION) ?? []) as unknown as readonly AutomationSdkExtension[];
        return exts.map((e) => ({ name: e.name, description: e.description }));
      },
    };
    return sdk;
  }

  async run(): Promise<AutomationRunResult> {
    const script = prepareAutomationScript(this.spec.script, this.spec.baseDir);
    validateScript(script);
    running.set(this.spec.name, this);
    this.startedAt = this.now();
    let stopped: AutomationRunResult["stopped"] = "completed";
    let error: string | undefined;

    // Cap policy (plan §6.3): with the kill switch armed there is no forced
    // ceiling (default unlimited, explicit values honored). Otherwise clamp.
    const armed = isKillSwitchArmed();
    const requested = this.opts.maxDurationMs;
    const maxDurationMs = (this.maxDurationMs = armed
      ? requested === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(500, requested)
      : Math.max(
          500,
          Math.min(
            MAX_AUTOMATION_DURATION_MS,
            requested ?? DEFAULT_AUTOMATION_DURATION_MS
          )
        ));
    if (Number.isFinite(maxDurationMs)) {
      this.durationTimer = setTimeout(() => {
        if (!this.ctl.stopped) {
          this.requestStop("duration");
          this.emit({ stopped: "duration", maxDurationMs });
        }
      }, Math.min(maxDurationMs, 2 ** 31 - 1));
      if (this.durationTimer.unref) this.durationTimer.unref();
    }

    // Build the extension context (shared across all extensions for this run).
    // Extensions are created before the script starts so the first line can
    // already use sdk.ext.* without awaiting anything.
    const abortController = new AbortController();
    const extCtx: import("./automationExtensions").AutomationExtensionContext = {
      automationName: this.spec.name,
      dryRun: !!this.opts.dryRun,
      signal: abortController.signal,
      isPaused: () => this.ctl.paused,
      log: (data) => this.emit(data),
      onDispose: (fn) => { this.disposeCallbacks.push(fn); },
      sdk: undefined as any, // filled below after sdk is built
    };
    this.extApis = await resolveExtensions(this.opts.extensions ?? null, extCtx);
    const sdk = this.buildSDK(this.extApis);
    // Now that sdk exists, back-fill it on the context so extensions that
    // lazily reference ctx.sdk (e.g. in onCommand handlers) get the real one.
    (extCtx as any).sdk = sdk;

    const reserved = new Set(["sdk", "callTool", "executeScript"]);
    const toolNames = (this.opts.toolsService?.getFunctionNames() ?? []).filter(
      (name) =>
        typeof name === "string" &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
        !reserved.has(name)
    );
    const callTool = sdk.callTool.bind(sdk);
    // As in knowhow-module-script, expose both a generic callTool and a named
    // top-level function for each registered tool. Named functions accept the
    // tool's normal JSON argument object; ToolsService handles positional tools.
    const toolFunctions = toolNames.map(
      (toolName) => (parameters: Record<string, unknown> = {}) =>
        callTool(toolName, parameters)
    );
    const fn = new AsyncFunction(
      "sdk",
      "callTool",
      ...toolNames,
      transpileMainScript(script)
    );
    try {
      await fn(sdk, callTool, ...toolFunctions);
      // Body settled. Stay resident while hotkeys/timers/watchers/keepAlive
      // retain the run (plan §6.2); ends on exit/stop/duration.
      await this.waitForLifetimeEnd();
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
      this.wakeLifetime();
      // Safety first: release held keys, then stop hotkeys, then user cleanup.
      await this.releaseHeldKeys();
      await this.unregisterHotkeys();
      await this.runExitHandlers();
      // Destroy native forms (the host also does this when the connection drops).
      this.guiService?.destroyAll();
      // Anything still retained is moot now; unblock any untilExit() waiters.
      this.requestStop("completed");
      this.retainers.clear();
      if (this.tooltipTimer) {
        clearTimeout(this.tooltipTimer);
        this.tooltipTimer = null;
      }
      // Abort the extension signal so extensions can tear down async work.
      try { abortController.abort(); } catch { /* best-effort */ }
      // Run extension dispose callbacks (in registration order).
      for (const fn of this.disposeCallbacks) {
        try { await fn(); } catch (e: any) {
          this.emit({ extensionDisposeError: e?.message ?? String(e) });
        }
      }
      this.disposeCallbacks = [];
      if (this.gateTimer) clearInterval(this.gateTimer);
      if (this.durationTimer) clearTimeout(this.durationTimer);
      if (this.pauseStartedAt) {
        this.pausedAccumMs += this.now() - this.pauseStartedAt;
        this.pauseStartedAt = 0;
      }
      for (const stop of [...this.streamDisposers]) stop();
      this.streamDisposers.clear();
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
      artifacts: this.artifacts,
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
