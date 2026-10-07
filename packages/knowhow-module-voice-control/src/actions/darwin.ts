/**
 * macOS PlatformActions implementation.
 *
 * Uses knowhow-module-computer-use's ComputerService for keys/typing/mouse.
 * Uses AppleScript/JXA (via ./osa) for window management.
 */

import { exec as nodeExec } from "child_process";
import { promisify } from "util";
import type { PlatformActions, MonitorInfo, WindowInfo, Rect, SnapPosition } from "./types";
import { runAppleScript, runJxa, escapeAppleScriptString } from "./osa";
import { createStandaloneComputerService } from "../computerService";
import type { ComputerUseAdapter } from "../computerService";

const exec = promisify(nodeExec);

export class DarwinPlatformActions implements PlatformActions {
  readonly platform = "darwin" as NodeJS.Platform;
  private computerService?: ComputerUseAdapter;
  private frontAppCache?: { at: number; name: string | undefined };

  constructor(injectedService?: unknown) {
    // Prefer an injected service (from VoiceSession / getPlatformActions)
    if (injectedService && typeof (injectedService as { typeText?: unknown }).typeText === "function") {
      this.computerService = injectedService as ComputerUseAdapter;
    } else {
      this.computerService = createStandaloneComputerService();
    }
  }

  private async applescript(script: string): Promise<string> {
    return (await runAppleScript(script)).trim();
  }

  private async jxa(script: string): Promise<string> {
    return (await runJxa(script)).trim();
  }

  async pressCombo(combo: string, opts?: { app?: string; repeat?: number }): Promise<void> {
    const repeat = opts?.repeat ?? 1;
    // Translate "mod" → "command", keep others
    const normalized = combo.replace(/\bmod\b/g, "command");
    const parts = normalized.split("+");
    const key = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);

    if (opts?.app) {
      await this.activateApp(opts.app);
    }

    if (this.computerService) {
      const svc = this.computerService;
      for (let i = 0; i < repeat; i++) {
        // ComputerService.pressKey(key) takes no modifiers (they were silently
        // dropped, so "full screen" typed a bare "f"); chords go via hotkey().
        if (modifiers.length) {
          await svc.hotkey(...modifiers, key);
        } else {
          await svc.pressKey?.(key);
        }
      }
    } else {
      // Fallback to AppleScript
      const asMod: Record<string, string> = { ctrl: "control", control: "control", alt: "option", option: "option", cmd: "command", command: "command", shift: "shift" };
      const modList = modifiers.map((m) => `${asMod[m] ?? m} down`).join(", ");
      const script = modList
        ? `tell application "System Events" to keystroke "${key}" using {${modList}}`
        : `tell application "System Events" to keystroke "${key}"`;
      for (let i = 0; i < repeat; i++) {
        await this.applescript(script);
      }
    }
  }

  async typeText(text: string, opts?: { app?: string }): Promise<void> {
    if (opts?.app) await this.activateApp(opts.app);
    if (this.computerService) {
      await this.computerService.typeText(text);
    } else {
      const escaped = escapeAppleScriptString(text);
      await this.applescript(`tell application "System Events" to keystroke "${escaped}"`);
    }
  }

  async frontmostApp(opts?: { maxWaitMs?: number; maxAgeMs?: number }): Promise<string | undefined> {
    // Short-TTL cache for hot paths (scan + publish ask back to back); the
    // default is uncached so activate→frontmost sequences stay exact.
    const maxAgeMs = opts?.maxAgeMs ?? 0;
    const cached = this.frontAppCache;
    if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) return cached.name;
    const read = this.jxa(
      `ObjC.import('AppKit'); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName);`,
    ).then(
      (name) => {
        const value = name || undefined;
        this.frontAppCache = { at: Date.now(), name: value };
        return value;
      },
      () => undefined,
    );
    if (!opts?.maxWaitMs) return read;
    return Promise.race([
      read,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), opts.maxWaitMs)),
    ]);
  }

  /**
   * Map a spoken/raw app name ("ghost", "Ghostty", "chrome") to the name of a
   * running process ("ghostty", "Google Chrome"). Returns undefined when nothing
   * running matches, so callers never `tell application "ghost"` (which makes
   * macOS search for the app and can take several seconds).
   */
  async resolveRunningApp(app: string): Promise<string | undefined> {
    let names: string[] = [];
    try {
      names = await this.listRunningAppsOrThrow();
    } catch {
      return app;
    }
    const want = app.toLowerCase().trim();
    const exact = names.find((n) => n.toLowerCase() === want);
    if (exact) return exact;
    const prefix = names.filter((n) => n.toLowerCase().startsWith(want));
    if (prefix.length === 1) return prefix[0];
    const contains = names.filter((n) => n.toLowerCase().split(/\s+/).includes(want));
    if (contains.length === 1) return contains[0];
    if (want.length >= 4) {
      const loose = names.filter((n) => n.toLowerCase().includes(want));
      if (loose.length === 1) return loose[0];
    }
    return undefined;
  }

  private async listRunningAppsOrThrow(): Promise<string[]> {
    const out = await this.jxa(
      `JSON.stringify(Application("System Events").applicationProcesses.whose({ backgroundOnly: false }).name())`,
    );
    return JSON.parse(out) as string[];
  }

  async listRunningApps(): Promise<string[]> {
    try {
      return await this.listRunningAppsOrThrow();
    } catch {
      return [];
    }
  }

  async activateApp(app: string, opts?: { launch?: boolean }): Promise<boolean> {
    this.frontAppCache = undefined;
    const running = await this.resolveRunningApp(app);
    if (running) {
      try {
        await this.applescript(
          `tell application "System Events" to set frontmost of application process ${JSON.stringify(running)} to true`,
        );
        return true;
      } catch { /* fall through */ }
    } else if (!opts?.launch) {
      return false;
    }
    try {
      await this.applescript(`tell application "${app}" to activate`);
      return true;
    } catch {
      if (opts?.launch) {
        try {
          await exec(`open -a ${JSON.stringify(app)}`);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  private readonly nsScreenScript = `
ObjC.import('AppKit');
var screens = $.NSScreen.screens;
var count = screens.count;
var primaryH = screens.objectAtIndex(0).frame.size.height;
var out = [];
for (var i = 0; i < count; i++) {
  var s = screens.objectAtIndex(i);
  var f = s.frame;
  var vf = s.visibleFrame;
  var bx = Math.round(f.origin.x);
  var by = Math.round(primaryH - f.origin.y - f.size.height);
  var bw = Math.round(f.size.width);
  var bh = Math.round(f.size.height);
  var wx = Math.round(vf.origin.x);
  var wy = Math.round(primaryH - vf.origin.y - vf.size.height);
  var ww = Math.round(vf.size.width);
  var wh = Math.round(vf.size.height);
  out.push({ id: i, bounds: { x: bx, y: by, width: bw, height: bh }, workArea: { x: wx, y: wy, width: ww, height: wh }, primary: i === 0 });
}
JSON.stringify(out);
`;

  /** Fetch NSScreen data (bounds + workArea) sorted left→right. */
  private async getNSScreenData(): Promise<Array<{ id: number; bounds: Rect; workArea: Rect; primary: boolean }> | undefined> {
    try {
      const result = await this.jxa(this.nsScreenScript);
      const screens = JSON.parse(result) as Array<{ id: number; bounds: Rect; workArea: Rect; primary: boolean }>;
      return screens.sort((a, b) => a.bounds.x - b.bounds.x);
    } catch {
      return undefined;
    }
  }

  async listMonitors(): Promise<MonitorInfo[]> {
    // Always get NSScreen data for workArea (ComputerService displays don't have it)
    const nsScreens = await this.getNSScreenData();

    // Try ComputerService displays first (has scaleFactor and reliable ids)
    try {
      if (this.computerService?.getDisplays) {
        const displays = await this.computerService.getDisplays();
        const sorted = displays.sort((a, b) => a.bounds.x - b.bounds.x);
        return sorted.map((d, i) => {
          const ns = nsScreens?.[i];
          return {
            index: i + 1,
            id: d.id ?? i,
            bounds: d.bounds as Rect,
            workArea: ns?.workArea ?? d.workArea,
            primary: d.primary ?? i === 0,
            name: d.name,
          };
        });
      }
    } catch {
      // fall through to NSScreen-only path
    }

    // Fallback: NSScreen only
    if (nsScreens) {
      return nsScreens.map((s, i) => ({ ...s, index: i + 1, name: undefined }));
    }

    return [{ index: 1, id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true }];
  }

  async frontWindow(app?: string): Promise<WindowInfo | undefined> {
    const target = app
      ? await this.resolveRunningApp(app)
      : await this.frontmostApp().catch(() => undefined);
    if (!target) return undefined;
    const name = JSON.stringify(target);
    // 1) Accessibility via System Events: works for every app, including ones
    //    with no AppleScript dictionary (Ghostty, many Electron apps), where
    //    Application(name).windows[0].bounds() throws "Can't convert types".
    //    Minimized windows are skipped so callers can restore them.
    try {
      const result = await this.jxa(`
        const se = Application("System Events");
        const procs = se.applicationProcesses.whose({ name: ${name} });
        let out = null;
        if (procs.length > 0) {
          const wins = procs[0].windows();
          for (const w of wins) {
            let mini = false;
            try { mini = w.attributes.byName("AXMinimized").value(); } catch (e) {}
            if (mini) continue;
            const pos = w.position(); const sz = w.size();
            out = { app: ${name}, title: w.name(), bounds: { x: pos[0], y: pos[1], width: sz[0], height: sz[1] } };
            break;
          }
        }
        JSON.stringify(out);
      `);
      const parsed = JSON.parse(result);
      if (parsed) return parsed as WindowInfo;
    } catch {
      /* fall back to the app's own scripting dictionary */
    }
    // 2) App scripting dictionary (Chrome, Finder, ...).
    try {
      const result = await this.jxa(`
        const app = Application(${name});
        const win = app.windows[0];
        const bounds = win.bounds();
        JSON.stringify({ app: ${name}, title: win.name(), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
      `);
      return JSON.parse(result) as WindowInfo;
    } catch {
      return undefined;
    }
  }

  async windowAt(point: { x: number; y: number }): Promise<WindowInfo | undefined> {
    // Use accessibility to find the window at a point
    try {
      const result = await this.jxa(`
        const se = Application("System Events");
        const processes = se.applicationProcesses.whose({ frontmost: true });
        if (processes.length === 0) { JSON.stringify(null); } else {
          const proc = processes[0];
          const wins = proc.windows();
          for (let w of wins) {
            try {
              const pos = w.position(); const sz = w.size();
              if (${point.x} >= pos[0] && ${point.x} <= pos[0]+sz[0] &&
                  ${point.y} >= pos[1] && ${point.y} <= pos[1]+sz[1]) {
                JSON.stringify({ app: proc.name(), title: w.name(), bounds: { x: pos[0], y: pos[1], width: sz[0], height: sz[1] } });
              }
            } catch(e) {}
          }
          JSON.stringify(null);
        }
      `);
      const parsed = JSON.parse(result);
      return parsed ?? undefined;
    } catch {
      return undefined;
    }
  }

  async setWindowBounds(win: WindowInfo, rect: Rect): Promise<void> {
    try {
      await this.jxa(`
        const se = Application("System Events");
        const procs = se.applicationProcesses.whose({ name: "${win.app}" });
        if (procs.length > 0) {
          const proc = procs[0];
          const wins = proc.windows();
          if (wins.length > 0) {
            wins[0].position = [${rect.x}, ${rect.y}];
            wins[0].size = [${rect.width}, ${rect.height}];
          }
        }
      `);
    } catch {
      // ignore
    }
  }

  async minimizeWindow(app?: string): Promise<void> {
    const target = app ? await this.resolveRunningApp(app) : await this.frontmostApp();
    if (!target) return;
    await this.applescript(`tell application "${target}" to set miniaturized of front window to true`).catch(() => {
      // Non-scriptable apps: set AXMinimized via System Events
      return this.applescript(
        `tell application "System Events" to tell application process "${target}" to set value of attribute "AXMinimized" of front window to true`,
      ).catch(() => undefined);
    });
  }

  async restoreWindow(app: string): Promise<void> {
    const resolved = await this.resolveRunningApp(app);
    if (!resolved) return;
    app = resolved;
    await this.applescript(
      `tell application "${app}" to set miniaturized of front window to false`,
    ).catch(() =>
      // Non-scriptable apps (Ghostty, Electron): un-minimize via accessibility.
      this.applescript(
        `tell application "System Events" to tell application process "${app}" to set value of attribute "AXMinimized" of every window to false`,
      ).catch(() => undefined),
    );
    await this.activateApp(app);
  }

  async toggleFullScreen(app?: string): Promise<void> {
    const target = app ?? (await this.frontmostApp());
    if (!target) return;
    await this.pressCombo("mod+ctrl+f", { app: target });
  }

  async scroll(dx: number, dy: number, at?: { x: number; y: number }): Promise<void> {
    const svc = this.computerService;
    if (svc?.scroll) {
      // Wheel events go to the window under the pointer, so put the pointer
      // where the user is looking first. ComputerService.scroll takes plain
      // (dx, dy) wheel deltas (the old object call silently did nothing).
      if (at && Number.isFinite(at.x) && Number.isFinite(at.y) && typeof svc.moveMouse === "function") {
        await svc.moveMouse({ x: Math.round(at.x), y: Math.round(at.y) }).catch(() => undefined);
      }
      // The native wheel event (CGEvent, line units) treats positive as
      // up/left; PlatformActions uses positive = down/right, so flip.
      await svc.scroll(-dx, -dy);
    } else {
      // Fallback: AppleScript scroll (limited)
      const lines = dy !== 0 ? [`tell application "System Events" to scroll down`] : [];
      if (lines.length) await this.applescript(lines.join("\n")).catch(() => undefined);
    }
  }

  async systemAction(
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
  ): Promise<void> {
    switch (name) {
      case "mission-control":
        await this.pressCombo("ctrl+up");
        break;
      case "show-desktop":
        await this.pressCombo("mod+f3");
        break;
      case "lock-screen":
        await this.pressCombo("ctrl+mod+q");
        break;
      case "spotlight":
        await this.pressCombo("mod+space");
        break;
      case "volume-up":
        await this.applescript("set volume output volume (output volume of (get volume settings) + 10)");
        break;
      case "volume-down":
        await this.applescript("set volume output volume (output volume of (get volume settings) - 10)");
        break;
      case "mute":
        await this.applescript("set volume with output muted");
        break;
      case "play-pause":
        await this.pressCombo("f8");
        break;
      case "next-track":
        await this.pressCombo("f9");
        break;
      case "previous-track":
        await this.pressCombo("f7");
        break;
      case "screenshot":
        await this.pressCombo("mod+shift+3");
        break;
    }
  }
}

/** Create the platform actions for the current OS. */
export function createPlatformActions(): PlatformActions | undefined {
  if (process.platform === "darwin") return new DarwinPlatformActions();
  return undefined;
}
