/**
 * Unit tests for the windows pack handlers using a fake PlatformActions.
 */

import { WINDOWS_PACK } from "../src/packs/windows";
import type { PlatformActions, MonitorInfo, WindowInfo, Rect } from "../src/actions/types";
import type { VoiceCommandContext } from "../src/voiceCommands";

// ─── Fake PlatformActions ─────────────────────────────────────────────────────

interface FakeState {
  windows: WindowInfo[];
  monitors: MonitorInfo[];
  activeApp?: string;
  setWindowBoundsCalls: Array<{ win: WindowInfo; rect: Rect }>;
  activateAppCalls: string[];
  minimizeCalls: Array<string | undefined>;
  restoreCalls: string[];
  toggleFullScreenCalls: Array<string | undefined>;
  comboCalls: string[];
  systemActionCalls: string[];
}

function makeFakeActions(state: FakeState): PlatformActions {
  return {
    platform: "darwin",
    async pressCombo(combo, opts) {
      if (opts?.app) state.activateAppCalls.push(opts.app);
      state.comboCalls.push(combo);
    },
    async typeText() {},
    async frontmostApp() {
      return state.activeApp;
    },
    async activateApp(app) {
      state.activateAppCalls.push(app);
      state.activeApp = app;
      return true;
    },
    async listMonitors() {
      return state.monitors;
    },
    async frontWindow(app) {
      if (app) {
        return state.windows.find((w) => w.app?.toLowerCase().includes(app.toLowerCase()));
      }
      return state.windows[0];
    },
    async windowAt(point) {
      return state.windows.find(
        (w) =>
          point.x >= w.bounds.x &&
          point.x < w.bounds.x + w.bounds.width &&
          point.y >= w.bounds.y &&
          point.y < w.bounds.y + w.bounds.height,
      );
    },
    async setWindowBounds(win, rect) {
      state.setWindowBoundsCalls.push({ win, rect });
      // Update bounds in state
      const idx = state.windows.findIndex((w) => w.id === win.id);
      if (idx >= 0) state.windows[idx] = { ...state.windows[idx], bounds: rect };
    },
    async minimizeWindow(app) {
      state.minimizeCalls.push(app);
    },
    async restoreWindow(app) {
      state.restoreCalls.push(app);
    },
    async toggleFullScreen(app) {
      state.toggleFullScreenCalls.push(app);
    },
    async scroll() {},
    async systemAction(name) {
      state.systemActionCalls.push(name);
    },
  };
}

function makeMonitor(index: number, x: number, y: number, w: number, h: number, opts: Partial<MonitorInfo> = {}): MonitorInfo {
  return { index, id: index, bounds: { x, y, width: w, height: h }, primary: index === 1, ...opts };
}

function makeWindow(id: number, app: string, x: number, y: number, w: number, h: number): WindowInfo {
  return { id, app, title: `${app} Window`, bounds: { x, y, width: w, height: h } };
}

// ─── Build fake context ───────────────────────────────────────────────────────

function makeCtx(
  actions: PlatformActions,
  slots: Record<string, unknown> = {},
  target?: { x: number; y: number },
): VoiceCommandContext & { actions: PlatformActions; slots: Record<string, unknown>; history: any[] } {
  return {
    actions,
    slots,
    history: [],
    phrase: "test",
    text: "test",
    spokenAt: Date.now(),
    recognizedAt: Date.now(),
    target: () => target,
    setMode: () => {},
    log: () => {},
  } as any;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findCmd(phrase: string) {
  const c = WINDOWS_PACK.find((c) => c.phrase === phrase || c.name === `windows.${phrase}`);
  if (!c) throw new Error(`Command not found: ${phrase}`);
  return c;
}

function findByName(name: string) {
  const c = WINDOWS_PACK.find((c) => c.name === `windows.${name}`);
  if (!c) throw new Error(`Command not found by name: windows.${name}`);
  return c;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WINDOWS_PACK", () => {
  let state: FakeState;
  let actions: PlatformActions;

  beforeEach(() => {
    state = {
      windows: [makeWindow(1, "Google Chrome", 100, 100, 800, 600)],
      monitors: [
        makeMonitor(1, 0, 0, 1920, 1080, { primary: true }),
        makeMonitor(2, 1920, 0, 1920, 1080),
      ],
      activeApp: "Google Chrome",
      setWindowBoundsCalls: [],
      activateAppCalls: [],
      minimizeCalls: [],
      restoreCalls: [],
      toggleFullScreenCalls: [],
      comboCalls: [],
      systemActionCalls: [],
    };
    actions = makeFakeActions(state);
  });

  // ── snap commands ─────────────────────────────────────────────────────────

  describe("snap-left", () => {
    test("snaps front window to left half of its monitor", async () => {
      const cmd = findByName("snap-left");
      const ctx = makeCtx(actions);
      await cmd.run(ctx as any);
      expect(state.setWindowBoundsCalls).toHaveLength(1);
      const { rect } = state.setWindowBoundsCalls[0];
      expect(rect.x).toBe(0);
      expect(rect.y).toBe(0);
      expect(rect.width).toBe(960);
      expect(rect.height).toBe(1080);
    });

    test("snaps named app window to left half", async () => {
      state.windows.push(makeWindow(2, "Obsidian", 200, 200, 600, 400));
      const cmd = findByName("snap-left");
      const ctx = makeCtx(actions, { app: "Obsidian" });
      await cmd.run(ctx as any);
      expect(state.setWindowBoundsCalls).toHaveLength(1);
      expect(state.setWindowBoundsCalls[0].win.app).toBe("Obsidian");
    });
  });

  describe("snap-right", () => {
    test("snaps front window to right half of its monitor", async () => {
      const cmd = findByName("snap-right");
      const ctx = makeCtx(actions);
      await cmd.run(ctx as any);
      const { rect } = state.setWindowBoundsCalls[0];
      expect(rect.x).toBe(960);
      expect(rect.width).toBe(960);
    });
  });

  describe("snap-top-left", () => {
    test("snaps to top-left quarter", async () => {
      const cmd = findByName("snap-top-left");
      await cmd.run(makeCtx(actions) as any);
      const { rect } = state.setWindowBoundsCalls[0];
      expect(rect).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    });
  });

  describe("snap-left-third", () => {
    test("snaps to left third", async () => {
      const cmd = findByName("snap-left-third");
      await cmd.run(makeCtx(actions) as any);
      const { rect } = state.setWindowBoundsCalls[0];
      expect(rect.width).toBe(640);
      expect(rect.x).toBe(0);
    });
  });

  describe("snap-monitor-left", () => {
    test("snaps to monitor 2 left half", async () => {
      const cmd = findByName("snap-monitor-left");
      const ctx = makeCtx(actions, { mon: "two" });
      await cmd.run(ctx as any);
      expect(state.setWindowBoundsCalls).toHaveLength(1);
      const { rect } = state.setWindowBoundsCalls[0];
      // Monitor 2 starts at x=1920
      expect(rect.x).toBe(1920);
      expect(rect.width).toBe(960);
    });
  });

  // ── maximize ─────────────────────────────────────────────────────────────

  describe("maximize", () => {
    test("sets window bounds to full monitor area", async () => {
      const cmd = findByName("maximize");
      await cmd.run(makeCtx(actions) as any);
      const { rect } = state.setWindowBoundsCalls[0];
      expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    });

    test("uses workArea when available", async () => {
      state.monitors[0] = makeMonitor(1, 0, 0, 1920, 1080, {
        workArea: { x: 0, y: 25, width: 1920, height: 985 },
        primary: true,
      });
      const cmd = findByName("maximize");
      await cmd.run(makeCtx(actions) as any);
      const { rect } = state.setWindowBoundsCalls[0];
      expect(rect.y).toBe(25);
      expect(rect.height).toBe(985);
    });
  });

  // ── fullscreen ────────────────────────────────────────────────────────────

  describe("fullscreen", () => {
    test("calls toggleFullScreen", async () => {
      const cmd = findByName("fullscreen");
      await cmd.run(makeCtx(actions) as any);
      expect(state.toggleFullScreenCalls).toHaveLength(1);
    });
  });

  // ── minimize / restore ────────────────────────────────────────────────────

  describe("minimize", () => {
    test("minimizes front window", async () => {
      const cmd = findByName("minimize");
      await cmd.run(makeCtx(actions) as any);
      expect(state.minimizeCalls).toHaveLength(1);
    });

    test("minimizes named app", async () => {
      const cmd = findByName("minimize");
      await cmd.run(makeCtx(actions, { app: "Obsidian" }) as any);
      expect(state.minimizeCalls[0]).toBe("Obsidian");
    });
  });

  describe("restore", () => {
    test("restores named app", async () => {
      const cmd = findByName("restore");
      await cmd.run(makeCtx(actions, { app: "Obsidian" }) as any);
      expect(state.restoreCalls).toContain("Obsidian");
    });
  });

  // ── move to monitor ───────────────────────────────────────────────────────

  describe("move-to-monitor", () => {
    test("moves to monitor 2, preserving relative position", async () => {
      // Window is at (100, 100), 800x600 on monitor 1 (1920x1080)
      // Relative: x=100/1920 ≈ 0.052, y=100/1080 ≈ 0.093
      const cmd = findByName("move-to-monitor");
      const ctx = makeCtx(actions, { mon: "two" });
      await cmd.run(ctx as any);
      expect(state.setWindowBoundsCalls).toHaveLength(1);
      const { rect } = state.setWindowBoundsCalls[0];
      // x should be around 1920 + 0.052*1920 ≈ 2020
      expect(rect.x).toBeGreaterThanOrEqual(1920);
      expect(rect.x).toBeLessThan(2100);
    });
  });

  // ── throw it ─────────────────────────────────────────────────────────────

  describe("throw-it", () => {
    test("moves front window to the other monitor", async () => {
      const cmd = findByName("throw-it");
      await cmd.run(makeCtx(actions) as any);
      expect(state.setWindowBoundsCalls).toHaveLength(1);
      const { rect } = state.setWindowBoundsCalls[0];
      // Should land on monitor 2 (x >= 1920)
      expect(rect.x).toBeGreaterThanOrEqual(1920);
    });
  });

  // ── center window ─────────────────────────────────────────────────────────

  describe("center-window", () => {
    test("centers window on its monitor", async () => {
      state.windows[0] = makeWindow(1, "Google Chrome", 0, 0, 800, 600);
      const cmd = findByName("center-window");
      await cmd.run(makeCtx(actions) as any);
      const { rect } = state.setWindowBoundsCalls[0];
      // Center of 1920x1080 with 800x600 window: x=(1920-800)/2=560, y=(1080-600)/2=240
      expect(rect.x).toBe(560);
      expect(rect.y).toBe(240);
      expect(rect.width).toBe(800);
      expect(rect.height).toBe(600);
    });
  });

  // ── change-window / switch-app ────────────────────────────────────────────

  describe("change-window", () => {
    test("sends mod+` combo", async () => {
      const cmd = findByName("change-window");
      await cmd.run(makeCtx(actions) as any);
      expect(state.comboCalls).toContain("mod+`");
    });
  });

  describe("switch-app", () => {
    test("sends mod+tab combo", async () => {
      const cmd = findByName("switch-app");
      await cmd.run(makeCtx(actions) as any);
      expect(state.comboCalls).toContain("mod+tab");
    });
  });

  // ── focus-this ────────────────────────────────────────────────────────────

  describe("focus-this", () => {
    test("activates the window under gaze", async () => {
      const cmd = findByName("focus-this");
      // Gaze at (150, 150) which is inside the Chrome window at (100,100,800,600)
      const ctx = makeCtx(actions, {}, { x: 150, y: 150 });
      await cmd.run(ctx as any);
      expect(state.activateAppCalls).toContain("Google Chrome");
    });

    test("does nothing if no gaze target", async () => {
      const cmd = findByName("focus-this");
      const ctx = makeCtx(actions, {}, undefined);
      await cmd.run(ctx as any);
      expect(state.activateAppCalls).toHaveLength(0);
    });
  });

  // ── tabs / window ops ─────────────────────────────────────────────────────

  describe("new-window", () => {
    test("sends mod+n", async () => {
      const cmd = findByName("new-window");
      await cmd.run(makeCtx(actions) as any);
      expect(state.comboCalls).toContain("mod+n");
    });
  });

  describe("new-tab", () => {
    test("sends mod+t", async () => {
      const cmd = findByName("new-tab");
      await cmd.run(makeCtx(actions) as any);
      expect(state.comboCalls).toContain("mod+t");
    });
  });

  describe("next-tab", () => {
    test("sends ctrl+tab", async () => {
      const cmd = findByName("next-tab");
      await cmd.run(makeCtx(actions) as any);
      expect(state.comboCalls).toContain("ctrl+tab");
    });
  });

  describe("close-window", () => {
    test("sends mod+w", async () => {
      const cmd = findByName("close-window");
      await cmd.run(makeCtx(actions) as any);
      expect(state.comboCalls).toContain("mod+w");
    });
  });

  // ── mission-control / show-desktop ────────────────────────────────────────

  describe("mission-control", () => {
    test("triggers mission-control system action", async () => {
      const cmd = findByName("mission-control");
      await cmd.run(makeCtx(actions) as any);
      expect(state.systemActionCalls).toContain("mission-control");
    });
  });

  describe("show-desktop", () => {
    test("triggers show-desktop system action", async () => {
      const cmd = findByName("show-desktop");
      await cmd.run(makeCtx(actions) as any);
      expect(state.systemActionCalls).toContain("show-desktop");
    });
  });

  // ── undo record ───────────────────────────────────────────────────────────

  describe("undo record", () => {
    test("snap records original bounds to ctx.history", async () => {
      const cmd = findByName("snap-left");
      const ctx = makeCtx(actions);
      await cmd.run(ctx as any);
      expect(ctx.history).toHaveLength(1);
      expect(ctx.history[0].type).toBe("window-bounds");
      expect(ctx.history[0].bounds).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    });

    test("undo record is skipped if ctx.history is undefined", async () => {
      const cmd = findByName("snap-left");
      const ctx = makeCtx(actions);
      delete (ctx as any).history;
      // Should not throw
      await expect(cmd.run(ctx as any)).resolves.toBeUndefined();
    });
  });

  // ── pack metadata ─────────────────────────────────────────────────────────

  describe("pack structure", () => {
    test("all commands have required fields", () => {
      for (const c of WINDOWS_PACK) {
        expect(c.type).toBe("voice-control.command");
        expect(typeof c.name).toBe("string");
        expect(c.name.startsWith("windows.")).toBe(true);
        expect(typeof c.phrase).toBe("string");
        expect(typeof c.run).toBe("function");
      }
    });

    test("no duplicate names", () => {
      const names = WINDOWS_PACK.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });
});
