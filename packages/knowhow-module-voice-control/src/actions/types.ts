/**
 * Platform-neutral actions interface.
 * Owned by agent "windows"; agent "core" adds key/text methods.
 *
 * OS-specific implementations live in src/actions/darwin.ts (etc.)
 * and register themselves by exporting `create(): PlatformActions`.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export interface MonitorInfo {
  /** 1-based, sorted left→right */
  index: number;
  id: string | number;
  bounds: Rect;
  workArea?: Rect;
  primary?: boolean;
  name?: string;
}

export interface WindowInfo {
  id?: number;
  app: string;
  title?: string;
  bounds: Rect;
}

export type SnapPosition =
  | "left" | "right" | "top" | "bottom" | "full" | "center"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "left-third" | "center-third" | "right-third"
  | "left-two-thirds" | "right-two-thirds";

export interface PlatformActions {
  platform: NodeJS.Platform;

  /** Press a keyboard combo. mod = Cmd on macOS, Ctrl on Win/Linux. */
  pressCombo(combo: string, opts?: { app?: string; repeat?: number }): Promise<void>;

  /** Type text into the focused app (or given app). */
  typeText(text: string, opts?: { app?: string }): Promise<void>;

  /**
   * Return the frontmost application name, or undefined.
   * - `maxWaitMs`: give up (resolve undefined) if the lookup takes longer.
   * - `maxAgeMs`: accept a result cached by a previous call this recent
   *   (hot paths that ask back to back); default is always fresh.
   */
  frontmostApp(opts?: { maxWaitMs?: number; maxAgeMs?: number }): Promise<string | undefined>;

  /** Activate an app by name, optionally launching if not running. Returns true on success. */
  activateApp(app: string, opts?: { launch?: boolean }): Promise<boolean>;

  /** Names of running, user-facing apps (used to suggest corrections for misheard app names). */
  listRunningApps?(): Promise<string[]>;

  /** List connected monitors, sorted left→right. */
  listMonitors(): Promise<MonitorInfo[]>;

  /** Front window of the given app (or frontmost app). */
  frontWindow(app?: string): Promise<WindowInfo | undefined>;

  /** Window at screen coordinates. */
  windowAt(point: { x: number; y: number }): Promise<WindowInfo | undefined>;

  /** Resize/reposition a window. */
  setWindowBounds(win: WindowInfo, rect: Rect): Promise<void>;

  /** Minimize app window. */
  minimizeWindow(app?: string): Promise<void>;

  /** Un-minimize / restore app window. */
  restoreWindow(app: string): Promise<void>;

  /** Toggle native full screen. */
  toggleFullScreen(app?: string): Promise<void>;

  /** Scroll at optional position (pixels). */
  scroll(dx: number, dy: number, at?: { x: number; y: number }): Promise<void>;

  /** Named system actions. */
  systemAction(
    name:
      | "mission-control"
      | "show-desktop"
      | "lock-screen"
      | "spotlight"
      | "volume-up"
      | "volume-down"
      | "mute"
      | "play-pause"
      | "next-track"
      | "previous-track"
      | "screenshot",
  ): Promise<void>;
}

/** Extension point for platform adapters contributed by external modules. */
export interface PlatformAdapterExtension {
  type: "voice-control.platform";
  /** Must match NodeJS.Platform values e.g. "win32", "linux". */
  platform: string;
  name: string;
  create(opts?: { computerService?: unknown }): PlatformActions;
}

// ─── Snap rect helper (pure, no I/O) ────────────────────────────────────────

/**
 * Compute the target rectangle for a snap position on a given monitor.
 * Uses workArea if available (excludes dock/taskbar), else bounds.
 */
export function snapRect(monitor: MonitorInfo, pos: SnapPosition): Rect {
  const area = monitor.workArea ?? monitor.bounds;
  const { x, y, width: w, height: h } = area;
  const half = Math.round(w / 2);
  const halfH = Math.round(h / 2);
  const third = Math.round(w / 3);

  switch (pos) {
    case "left":            return { x, y, width: half, height: h };
    case "right":           return { x: x + half, y, width: w - half, height: h };
    case "top":             return { x, y, width: w, height: halfH };
    case "bottom":          return { x, y: y + halfH, width: w, height: h - halfH };
    case "full":            return { x, y, width: w, height: h };
    case "center":          return { x: x + Math.round(w / 4), y: Math.round(h / 8), width: half, height: Math.round(h * 3 / 4) };
    case "top-left":        return { x, y, width: half, height: halfH };
    case "top-right":       return { x: x + half, y, width: w - half, height: halfH };
    case "bottom-left":     return { x, y: y + halfH, width: half, height: h - halfH };
    case "bottom-right":    return { x: x + half, y: y + halfH, width: w - half, height: h - halfH };
    case "left-third":      return { x, y, width: third, height: h };
    case "center-third":    return { x: x + third, y, width: third, height: h };
    case "right-third":     return { x: x + 2 * third, y, width: w - 2 * third, height: h };
    case "left-two-thirds": return { x, y, width: 2 * third, height: h };
    case "right-two-thirds":return { x: x + third, y, width: w - third, height: h };
    default:                return { x, y, width: w, height: h };
  }
}

// ─── Monitor resolver ────────────────────────────────────────────────────────

/**
 * Resolve a spoken monitor reference to a MonitorInfo.
 * spoken: "one"/"two"/1/2/"left"/"right"/"this"/"other"
 */
export function resolveMonitor(
  spoken: string | number | undefined,
  monitors: MonitorInfo[],
  current?: MonitorInfo,
): MonitorInfo | undefined {
  if (!monitors.length) return undefined;
  if (spoken === undefined || spoken === "this") return current ?? monitors[0];
  if (spoken === "other") {
    if (!current) return monitors[1] ?? monitors[0];
    return monitors.find((m) => m.id !== current.id) ?? monitors[0];
  }
  if (spoken === "primary" || spoken === "main") return monitors.find((m) => m.primary) ?? monitors[0];
  if (spoken === "left") return monitors[0];
  if (spoken === "right") return monitors[monitors.length - 1];
  // Word-to-number mapping for spoken ordinals
  const wordToNum: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    first: 1, second: 2, third: 3, fourth: 4,
  };
  const s = typeof spoken === "string" ? spoken.toLowerCase().trim() : "";
  if (s in wordToNum) {
    const idx = wordToNum[s];
    return monitors.find((m) => m.index === idx);
  }
  const num = typeof spoken === "number" ? spoken : parseInt(String(spoken), 10);
  if (!isNaN(num)) return monitors.find((m) => m.index === num) ?? monitors[num - 1];
  return undefined;
}

// ─── No-op stub for testing ──────────────────────────────────────────────────

export function createNoopActions(platform: NodeJS.Platform = process.platform): PlatformActions {
  const noop = async () => undefined as any;
  return {
    platform,
    pressCombo: noop,
    typeText: noop,
    frontmostApp: async () => undefined,
    activateApp: async () => false,
    listMonitors: async () => [],
    frontWindow: async () => undefined,
    windowAt: async () => undefined,
    setWindowBounds: noop,
    minimizeWindow: noop,
    restoreWindow: noop,
    toggleFullScreen: noop,
    scroll: noop,
    systemAction: noop,
  };
}
