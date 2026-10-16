/**
 * Windows pack — window management commands.
 *
 * Commands per commands.md §5. All commands talk to PlatformActions via ctx.actions
 * (falls back to getPlatformActions() when not provided in ctx).
 */

import type { PackCommandContext } from "./define";
import { defineVoicePack } from "./define";
import type { PlatformActions, MonitorInfo, WindowInfo, Rect, SnapPosition } from "../actions/types";
import { snapRect, resolveMonitor } from "../actions/types";
import { monitorForPoint, sortAndIndexMonitors } from "../actions/snap";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UndoRecord {
  type: "window-bounds";
  win: WindowInfo;
  bounds: Rect;
}

// Use VoiceCommandContext directly (slots, repeat, actions, history are defined there)
type ExtendedCtx = PackCommandContext;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getActions(ctx: ExtendedCtx): PlatformActions {
  return ctx.actions ?? ctx.services.platform;
}

/** Get slot value safely. */
function slot(ctx: ExtendedCtx, key: string): string | undefined {
  const v = ctx.slots?.[key];
  return v !== undefined ? String(v) : undefined;
}

/** Record an undo record for the previous bounds of a window (defensive). */
function recordUndo(ctx: ExtendedCtx, win: WindowInfo): void {
  const history = ctx.history as UndoRecord[] | undefined;
  if (!history) return;
  history.push({ type: "window-bounds", win, bounds: { ...win.bounds } });
}

/** Layouts persist to ~/.knowhow/voice-layouts.json */
const LAYOUTS_FILE = join(homedir(), ".knowhow", "voice-layouts.json");

type LayoutMap = Record<string, Record<string, Rect>>; // name → { app → bounds }

async function loadLayouts(): Promise<LayoutMap> {
  try {
    const raw = await readFile(LAYOUTS_FILE, "utf8");
    return JSON.parse(raw) as LayoutMap;
  } catch {
    return {};
  }
}

async function saveLayouts(layouts: LayoutMap): Promise<void> {
  await mkdir(join(homedir(), ".knowhow"), { recursive: true });
  await writeFile(LAYOUTS_FILE, JSON.stringify(layouts, null, 2), "utf8");
}

/** Find the monitor containing a window (center point heuristic). */
async function monitorForWindow(win: WindowInfo, actions: PlatformActions): Promise<MonitorInfo | undefined> {
  const monitors = await actions.listMonitors();
  if (!monitors.length) return undefined;
  const center = {
    x: win.bounds.x + win.bounds.width / 2,
    y: win.bounds.y + win.bounds.height / 2,
  };
  return monitorForPoint(center, monitors);
}

/** Parse a snap side string to a SnapPosition. */
function parseSide(side: string | undefined): SnapPosition {
  if (!side) return "full";
  const s = side.toLowerCase().trim().replace(/\s+/g, "-");
  const valid: SnapPosition[] = [
    "left",
    "right",
    "top",
    "bottom",
    "full",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "left-third",
    "center-third",
    "right-third",
    "left-two-thirds",
    "right-two-thirds",
    "center",
  ];
  return (valid.includes(s as SnapPosition) ? s : "full") as SnapPosition;
}

// ─── Command implementations ─────────────────────────────────────────────────

/**
 * Find the target window; if a named app has no visible window (e.g. it was
 * just minimized by "minimize chrome"), restore it and look again.
 */
async function findWindow(ctx: ExtendedCtx, app: string | undefined) {
  const actions = getActions(ctx);
  let win = await actions.frontWindow(app);
  if (!win && app) {
    try {
      await actions.restoreWindow(app);
      await ctx.services.clock.sleep(250);
      win = await actions.frontWindow(app);
    } catch {
      /* fall through to "no window" */
    }
  }
  return win;
}

/** snap to side on the window's current monitor */
async function snapToSide(ctx: ExtendedCtx, app: string | undefined, side: SnapPosition): Promise<void> {
  const actions = getActions(ctx);
  const win = await findWindow(ctx, app);
  if (!win) {
    ctx.log(`snap: no window found${app ? ` for ${app}` : ""}`);
    return;
  }

  const monitor = await monitorForWindow(win, actions);
  if (!monitor) {
    ctx.log("snap: no monitor found");
    return;
  }

  recordUndo(ctx, win);
  const rect = snapRect(monitor, side);
  await actions.setWindowBounds(win, rect);
}

/** snap to side on a given monitor */
async function snapToMonitorSide(
  ctx: ExtendedCtx,
  app: string | undefined,
  monSpoken: string | undefined,
  side: SnapPosition
): Promise<void> {
  const actions = getActions(ctx);
  const monitors = await actions.listMonitors();
  const win = await findWindow(ctx, app);
  const currentMon = win ? await monitorForWindow(win, actions) : undefined;
  const monitor = resolveMonitor(monSpoken, monitors, currentMon);
  if (!monitor) {
    ctx.log(`snap: monitor "${monSpoken}" not found`);
    return;
  }

  if (!win) {
    ctx.log(`snap: no window found${app ? ` for ${app}` : ""}`);
    return;
  }

  recordUndo(ctx, win);
  const rect = snapRect(monitor, side);
  await actions.setWindowBounds(win, rect);
}

// ─── Pack definition ──────────────────────────────────────────────────────────

export const WINDOWS_PACK = defineVoicePack({
  name: "windows",
  description: "Window management: focus, snap, move between monitors, minimize, full screen",
  prefix: "windows.",
  commands: ({ command }) => [
    // ── Change / next window ──────────────────────────────────────────────────
    command({
      name: "change-window",
      phrase: "change window",
      description: "Cycle to next window within the same app (Cmd-`)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("mod+`");
      },
      aliases: ["next window"],
      platforms: ["darwin"],
    }),

    command({
      name: "switch-app",
      phrase: "switch app",
      description: "Switch to another app (Cmd-Tab)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("mod+tab");
      },
      platforms: ["darwin"],
    }),

    // ── Focus / open app ─────────────────────────────────────────────────────
    command({
      name: "focus-app",
      phrase: "focus {app:app}",
      description: "Activate/open the named app",
      run: async (ctx) => {
        const app = slot(ctx, "app") ?? "";
        if (!app) {
          ctx.log("focus: no app name");
          return;
        }
        await getActions(ctx).activateApp(app, { launch: true });
      },
      aliases: ["switch to {app:app}", "open {app:app}"],
      patterns: ["focus {app:app}", "switch to {app:app}", "open {app:app}"],
    }),

    // ── Focus this (window under gaze) ────────────────────────────────────────
    command({
      name: "focus-this",
      phrase: "focus this",
      description: "Focus the window under the gaze cursor",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const pos = ctx.target();
        if (!pos) {
          ctx.log("focus this: no gaze target");
          return;
        }
        const win = await actions.windowAt(pos);
        if (!win?.app) {
          ctx.log("focus this: no window at gaze");
          return;
        }
        await actions.activateApp(win.app);
      },
    }),

    // ── Minimize ──────────────────────────────────────────────────────────────
    command({
      name: "minimize",
      phrase: "minimize",
      description: "Minimize the front window",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await getActions(ctx).minimizeWindow(app);
      },
      aliases: ["minimize {app:app}"],
      patterns: ["minimize [window]", "minimize [{app:app}]"],
    }),

    // ── Restore ───────────────────────────────────────────────────────────────
    command({
      name: "restore",
      phrase: "restore {app:app}",
      description: "Un-minimize the app's window",
      run: async (ctx) => {
        const app = slot(ctx, "app") ?? "";
        if (!app) {
          ctx.log("restore: no app");
          return;
        }
        await getActions(ctx).restoreWindow(app);
      },
    }),

    // ── Maximize ──────────────────────────────────────────────────────────────
    command({
      name: "maximize",
      phrase: "maximize",
      description: "Maximize the front window to fill its monitor",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const win = await findWindow(ctx, slot(ctx, "app"));
        if (!win) {
          ctx.log("maximize: no front window");
          return;
        }
        const monitor = await monitorForWindow(win, actions);
        if (!monitor) {
          ctx.log("maximize: no monitor");
          return;
        }
        recordUndo(ctx, win);
        const rect = snapRect(monitor, "full");
        await actions.setWindowBounds(win, rect);
      },
      patterns: ["maximize [window]", "maximize {app:app}"],
    }),

    // ── Full screen ───────────────────────────────────────────────────────────
    command({
      name: "fullscreen",
      phrase: "full screen",
      description: "Toggle native fullscreen for the front window",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await getActions(ctx).toggleFullScreen(app);
      },
      aliases: ["full-screen", "fullscreen"],
      patterns: ["full screen", "full screen [{app:app}]"],
    }),

    // ── Snap to side (current monitor) ────────────────────────────────────────
    command({
      name: "snap-left",
      phrase: "snap left",
      description: "Snap front window to the left half",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "left");
      },
      patterns: ["snap [window] left", "snap [{app:app}] left", "snap {app:app} left"],
    }),

    command({
      name: "snap-right",
      phrase: "snap right",
      description: "Snap front window to the right half",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "right");
      },
      patterns: ["snap [window] right", "snap [{app:app}] right", "snap {app:app} right"],
    }),

    command({
      name: "snap-top",
      phrase: "snap top",
      description: "Snap front window to the top half",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "top");
      },
      patterns: ["snap [window] top", "snap [{app:app}] top"],
    }),

    command({
      name: "snap-bottom",
      phrase: "snap bottom",
      description: "Snap front window to the bottom half",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "bottom");
      },
      patterns: ["snap [window] bottom", "snap [{app:app}] bottom"],
    }),

    command({
      name: "snap-top-left",
      phrase: "snap top left",
      description: "Snap front window to the top-left quarter",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "top-left");
      },
      patterns: ["snap [window] top left", "snap [{app:app}] top left"],
    }),

    command({
      name: "snap-top-right",
      phrase: "snap top right",
      description: "Snap front window to the top-right quarter",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "top-right");
      },
      patterns: ["snap [window] top right", "snap [{app:app}] top right"],
    }),

    command({
      name: "snap-bottom-left",
      phrase: "snap bottom left",
      description: "Snap front window to the bottom-left quarter",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "bottom-left");
      },
      patterns: ["snap [window] bottom left", "snap [{app:app}] bottom left"],
    }),

    command({
      name: "snap-bottom-right",
      phrase: "snap bottom right",
      description: "Snap front window to the bottom-right quarter",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "bottom-right");
      },
      patterns: ["snap [window] bottom right", "snap [{app:app}] bottom right"],
    }),

    command({
      name: "snap-left-third",
      phrase: "snap left third",
      description: "Snap front window to the left third",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "left-third");
      },
      patterns: ["snap [window] left third", "snap [{app:app}] left third"],
    }),

    command({
      name: "snap-center-third",
      phrase: "snap center third",
      description: "Snap front window to the center third",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "center-third");
      },
      patterns: ["snap [window] center third", "snap [{app:app}] center third"],
    }),

    command({
      name: "snap-right-third",
      phrase: "snap right third",
      description: "Snap front window to the right third",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "right-third");
      },
      patterns: ["snap [window] right third", "snap [{app:app}] right third"],
    }),

    command({
      name: "snap-left-two-thirds",
      phrase: "snap left two thirds",
      description: "Snap front window to the left two thirds",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "left-two-thirds");
      },
      patterns: ["snap [window] left two thirds", "snap [{app:app}] left two thirds"],
    }),

    command({
      name: "snap-right-two-thirds",
      phrase: "snap right two thirds",
      description: "Snap front window to the right two thirds",
      run: async (ctx) => {
        const app = slot(ctx, "app");
        await snapToSide(ctx, app, "right-two-thirds");
      },
      patterns: ["snap [window] right two thirds", "snap [{app:app}] right two thirds"],
    }),

    // ── Snap to monitor + side ────────────────────────────────────────────────
    // One command per side. (Previously right/full patterns were attached to the
    // "left" handler, so "snap chrome monitor 2 right" snapped LEFT.)
    ...(["left", "right", "full"] as const).map((side) =>
      command({
        name: `snap-monitor-${side}`,
        phrase: `snap monitor {mon:monitor} ${side}`,
        description: `Snap front window to the ${side === "full" ? "whole" : `${side} half of a`} monitor`,
        run: async (ctx) => {
          const app = slot(ctx, "app");
          const mon = slot(ctx, "mon");
          await snapToMonitorSide(ctx, app, mon, side);
        },
        patterns: [
          `snap [window] [to] monitor {mon:monitor} ${side}`,
          `snap {app:app} [to] monitor {mon:monitor} ${side}`,
          `snap [window] ${side} [on] [to] monitor {mon:monitor}`,
          `snap {app:app} ${side} [on] [to] monitor {mon:monitor}`,
        ],
      })
    ),

    // ── Move to monitor ───────────────────────────────────────────────────────
    command({
      name: "move-to-monitor",
      phrase: "move to monitor {mon:monitor}",
      description: "Move front window to the given monitor (keep relative size)",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const app = slot(ctx, "app");
        const monSpoken = slot(ctx, "mon");
        const monitors = await actions.listMonitors();
        const win = await findWindow(ctx, app);
        if (!win) {
          ctx.log("move to monitor: no window");
          return;
        }

        const currentMon = await monitorForWindow(win, actions);
        const targetMon = resolveMonitor(monSpoken, monitors, currentMon);
        if (!targetMon) {
          ctx.log(`move to monitor: monitor "${monSpoken}" not found`);
          return;
        }

        recordUndo(ctx, win);
        // Compute relative position on source monitor, apply to target
        const srcArea = currentMon?.workArea ?? currentMon?.bounds ?? win.bounds;
        const tgtArea = targetMon.workArea ?? targetMon.bounds;
        const relX = (win.bounds.x - srcArea.x) / srcArea.width;
        const relY = (win.bounds.y - srcArea.y) / srcArea.height;
        const relW = win.bounds.width / srcArea.width;
        const relH = win.bounds.height / srcArea.height;

        const newRect: Rect = {
          x: Math.round(tgtArea.x + relX * tgtArea.width),
          y: Math.round(tgtArea.y + relY * tgtArea.height),
          width: Math.round(relW * tgtArea.width),
          height: Math.round(relH * tgtArea.height),
        };
        await actions.setWindowBounds(win, newRect);
      },
      patterns: ["move [to] monitor {mon:monitor}", "move {app:app} [to] monitor {mon:monitor}"],
    }),

    // ── Throw it (move to the other monitor) ─────────────────────────────────
    command({
      name: "throw-it",
      phrase: "throw it",
      description: "Move the front window to the other monitor",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const win = await actions.frontWindow();
        if (!win) {
          ctx.log("throw it: no front window");
          return;
        }
        const monitors = await actions.listMonitors();
        const currentMon = await monitorForWindow(win, actions);
        const other = resolveMonitor("other", monitors, currentMon);
        if (!other) {
          ctx.log("throw it: only one monitor");
          return;
        }

        recordUndo(ctx, win);
        const srcArea = currentMon?.workArea ?? currentMon?.bounds ?? win.bounds;
        const tgtArea = other.workArea ?? other.bounds;
        const relX = (win.bounds.x - srcArea.x) / srcArea.width;
        const relY = (win.bounds.y - srcArea.y) / srcArea.height;
        const relW = win.bounds.width / srcArea.width;
        const relH = win.bounds.height / srcArea.height;

        const newRect: Rect = {
          x: Math.round(tgtArea.x + relX * tgtArea.width),
          y: Math.round(tgtArea.y + relY * tgtArea.height),
          width: Math.round(relW * tgtArea.width),
          height: Math.round(relH * tgtArea.height),
        };
        await actions.setWindowBounds(win, newRect);
      },
    }),

    // ── Center window ─────────────────────────────────────────────────────────
    command({
      name: "center-window",
      phrase: "center window",
      description: "Center the front window on its monitor",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const win = await actions.frontWindow();
        if (!win) {
          ctx.log("center window: no front window");
          return;
        }
        const monitor = await monitorForWindow(win, actions);
        if (!monitor) {
          ctx.log("center window: no monitor");
          return;
        }
        const area = monitor.workArea ?? monitor.bounds;
        recordUndo(ctx, win);
        const newRect: Rect = {
          x: Math.round(area.x + (area.width - win.bounds.width) / 2),
          y: Math.round(area.y + (area.height - win.bounds.height) / 2),
          width: win.bounds.width,
          height: win.bounds.height,
        };
        await actions.setWindowBounds(win, newRect);
      },
    }),

    // ── Save layout ───────────────────────────────────────────────────────────
    command({
      name: "save-layout",
      phrase: "save layout {name:text}",
      description: "Save current window arrangement as a named layout",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const name = slot(ctx, "name") ?? "default";
        const wins = await (async () => {
          try {
            // Use listWindows from the underlying service if accessible
            const cs = (actions as any).cs ?? (actions as any)._cs;
            if (cs?.listWindows) {
              return (await cs.listWindows()) as Array<{ app?: string; bounds?: Rect }>;
            }
            // Fallback: just front window
            const w = await actions.frontWindow();
            return w ? [w] : [];
          } catch {
            return [];
          }
        })();

        const layouts = await loadLayouts();
        layouts[name] = {};
        for (const w of wins) {
          if (w.app && w.bounds) layouts[name][w.app] = w.bounds;
        }
        await saveLayouts(layouts);
        ctx.log(`layout "${name}" saved (${Object.keys(layouts[name]).length} windows)`);
      },
      patterns: ["save layout {name:text}"],
    }),

    // ── Restore layout ────────────────────────────────────────────────────────
    command({
      name: "layout",
      phrase: "layout {name:text}",
      description: "Restore a saved window layout",
      run: async (ctx) => {
        const actions = getActions(ctx);
        const name = slot(ctx, "name") ?? "default";
        const layouts = await loadLayouts();
        const layout = layouts[name];
        if (!layout) {
          ctx.log(`layout "${name}" not found`);
          return;
        }

        for (const [app, bounds] of Object.entries(layout)) {
          try {
            const win = await actions.frontWindow(app);
            if (win) {
              await actions.setWindowBounds(win, bounds);
            }
          } catch {
            // ignore windows that aren't open
          }
        }
        ctx.log(`layout "${name}" restored`);
      },
      patterns: ["layout {name:text}"],
    }),

    // ── Close window / tab ────────────────────────────────────────────────────
    command({
      name: "close-window",
      phrase: "close window",
      description: "Close the front window (Cmd-W)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("mod+w");
      },
      aliases: ["close tab"],
    }),

    // ── Quit app ──────────────────────────────────────────────────────────────
    command({
      name: "quit-app",
      phrase: "quit {app:app}",
      description: "Quit the named app (Cmd-Q, ask confirmation)",
      run: async (ctx) => {
        const app = slot(ctx, "app") ?? "";
        if (!app) {
          ctx.log("quit: no app name");
          return;
        }
        const actions = getActions(ctx);
        await actions.activateApp(app);
        await actions.pressCombo("mod+q");
      },
      risk: "confirm",
    }),

    // ── New window / tab ──────────────────────────────────────────────────────
    command({
      name: "new-window",
      phrase: "new window",
      description: "Open a new window (Cmd-N)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("mod+n");
      },
    }),

    command({
      name: "new-tab",
      phrase: "new tab",
      description: "Open a new tab (Cmd-T)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("mod+t");
      },
    }),

    command({
      name: "next-tab",
      phrase: "next tab",
      description: "Go to the next tab (Ctrl-Tab)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("ctrl+tab");
      },
    }),

    command({
      name: "previous-tab",
      phrase: "previous tab",
      description: "Go to the previous tab (Ctrl-Shift-Tab)",
      run: async (ctx) => {
        await getActions(ctx).pressCombo("ctrl+shift+tab");
      },
    }),

    command({
      name: "tab-n",
      phrase: "tab {n:number}",
      description: "Switch to tab number N (Cmd-N)",
      run: async (ctx) => {
        const n = slot(ctx, "n") ?? "1";
        await getActions(ctx).pressCombo(`mod+${n}`);
      },
      patterns: ["tab {n:number}"],
    }),

    // ── Mission control / show desktop ────────────────────────────────────────
    command({
      name: "mission-control",
      phrase: "mission control",
      description: "Show Mission Control",
      run: async (ctx) => {
        await getActions(ctx).systemAction("mission-control");
      },
      platforms: ["darwin"],
    }),

    command({
      name: "show-desktop",
      phrase: "show desktop",
      description: "Show the desktop (hide all windows)",
      run: async (ctx) => {
        await getActions(ctx).systemAction("show-desktop");
      },
      platforms: ["darwin"],
    }),
  ],
});
