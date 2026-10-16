/**
 * Gaze mouse pack: eye-tracking mouse control, clicks, scroll, nudge, mark/drag.
 * Covers commands.md §2.
 */

import type { PackCommandContext } from "./define";
import { defineVoicePack } from "./define";
import type { TimerHandle } from "../services";

type Point = { x: number; y: number };

/** Wheel lines per "scroll up/down". */
const SCROLL_STEP_LINES = 5;

/** Continuous (auto) scroll state. */
interface ScrollState {
  timer: TimerHandle;
  dir: 1 | -1;
  linesPerTick: number;
  tickMs: number;
  busy: boolean;
}

/** Per-session gaze-mouse state (was module-level `let`s). */
export interface GazeMouseState {
  /** Stored mark point for mark→drag. */
  markPoint?: Point;
  /** Stored "select from here" point. */
  selectFromPoint?: Point;
  /** Running auto-scroll, if any. */
  scroll?: ScrollState;
}

type GazeCtx = PackCommandContext<GazeMouseState>;

function stopContinuousScroll(ctx: GazeCtx): void {
  if (ctx.state.scroll) {
    ctx.services.clock.clearTimeout(ctx.state.scroll.timer);
    ctx.state.scroll = undefined;
  }
}

async function scrollAt(ctx: GazeCtx, dx: number, dy: number, at?: { x: number; y: number } | null): Promise<void> {
  const actions = ctx.services.platform;
  if (!actions) return ctx.log("[voice] scroll: no platform actions available");
  await actions.scroll(dx, dy, at ?? undefined);
}

const SCROLL_SPEEDS = {
  slow: { linesPerTick: 1, tickMs: 160 },
  medium: { linesPerTick: 2, tickMs: 120 },
  fast: { linesPerTick: 5, tickMs: 120 },
} as const;

async function startContinuousScroll(ctx: GazeCtx, dir: 1 | -1, speed: keyof typeof SCROLL_SPEEDS): Promise<void> {
  stopContinuousScroll(ctx);
  // Put the pointer over the gaze target once, then scroll in place.
  await scrollAt(ctx, 0, 0, ctx.target());
  const { clock } = ctx.services;
  const state: ScrollState = {
    timer: undefined as unknown as TimerHandle,
    dir,
    ...SCROLL_SPEEDS[speed],
    busy: false,
  };
  const tick = async () => {
    if (ctx.state.scroll !== state) return;
    if (!state.busy) {
      state.busy = true;
      try {
        await scrollAt(ctx, 0, state.dir * state.linesPerTick);
      } catch {
        /* keep going */
      } finally {
        state.busy = false;
      }
    }
    if (ctx.state.scroll === state) {
      state.timer = clock.setTimeout(tick, state.tickMs);
      state.timer.unref?.();
    }
  };
  ctx.state.scroll = state;
  state.timer = clock.setTimeout(tick, 0);
  state.timer.unref?.();
  ctx.log(
    `[voice] auto-scrolling ${dir > 0 ? "down" : "up"} (${speed}); say "stop" to stop, "faster"/"slower" to adjust`
  );
}

export const GAZE_MOUSE_PACK = defineVoicePack<GazeMouseState>({
  name: "gaze-mouse",
  description: "Eye-tracking mouse control, scroll, nudge, mark / drag, select",
  prefix: "voice-control.gaze.",
  createState: () => ({}),
  onSessionStop: ({ state, services }) => {
    // Auto-scroll is the only timer this pack owns.
    if (state.scroll) services.clock.clearTimeout(state.scroll.timer);
    state.scroll = undefined;
    state.markPoint = undefined;
    state.selectFromPoint = undefined;
  },
  commands: ({ command }) => [
    // ─── Gaze-follow control ──────────────────────────────────────────────────
    command({
      name: "toggle-mouse",
      phrase: "toggle mouse",
      description: "Toggle gaze-controlled mouse movement",
      run: (ctx) => {
        if (ctx.gazeFollow?.isRunning()) {
          ctx.gazeFollow.stop();
          ctx.services.packs.peek<{ stopSmartMouse(): void }>("hints")?.stopSmartMouse();
          ctx.services.log.info("gaze mouse OFF");
        } else {
          ctx.gazeFollow?.start();
          ctx.services.log.info("gaze mouse ON");
        }
      },
    }),

    // ─── Clicks ──────────────────────────────────────────────────────────────
    command({
      name: "mouse-here",
      phrase: "mouse here",
      description: "Move the pointer once to where you're looking (no click)",
      run: async (ctx) => {
        const pos = ctx.target();
        if (!pos) return ctx.log("[voice] mouse here: no gaze point");
        if (ctx.mouse) await ctx.mouse.moveMouse(pos.x, pos.y);
      },
      aliases: ["move mouse here", "move the mouse here", "mouse over here", "move mouse", "cursor here", "hover here"],
    }),

    command({
      name: "triple-click",
      phrase: "triple click",
      description: "Triple-click where you are looking",
      run: async (ctx) => {
        const pos = ctx.target();
        if (pos && ctx.mouse) {
          await ctx.mouse.clickAt(pos.x, pos.y, "left");
          await ctx.mouse.clickAt(pos.x, pos.y, "left");
          await ctx.mouse.clickAt(pos.x, pos.y, "left");
        }
      },
    }),

    command({
      name: "command-click",
      phrase: "command click",
      description: "Command-click (Cmd+Click) where you are looking",
      run: async (ctx) => {
        const pos = ctx.target();
        const actions = ctx.services.platform;
        if (pos && actions) {
          await ctx.mouse?.moveMouse(pos.x, pos.y);
          await actions.pressCombo("mod+click");
        } else if (pos && ctx.mouse) {
          // fallback: move then click without modifier
          await ctx.mouse.clickAt(pos.x, pos.y, "left");
        }
      },
    }),

    command({
      name: "shift-click",
      phrase: "shift click",
      description: "Shift-click where you are looking",
      run: async (ctx) => {
        const pos = ctx.target();
        if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "left");
      },
    }),

    command({
      name: "option-click",
      phrase: "option click",
      description: "Option-click where you are looking",
      run: async (ctx) => {
        const pos = ctx.target();
        if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "left");
      },
      aliases: ["alt click"],
    }),

    // ─── Nudge ───────────────────────────────────────────────────────────────
    command({
      name: "nudge",
      phrase: "nudge",
      description: "Nudge pointer 20px in a direction",
      run: async (ctx) => {
        // Pattern with slots handled by grammar; fallback here parses text
        const text = ctx.text.toLowerCase();
        const n = parseInt(text.match(/\d+/)?.[0] ?? "1") || 1;
        const dist = 20 * n;
        const pos = ctx.gazeFollow?.currentPosition() ?? ctx.target();
        if (!pos || !ctx.mouse) return;
        let { x, y } = pos;
        if (text.includes("left")) x -= dist;
        else if (text.includes("right")) x += dist;
        else if (text.includes("up")) y -= dist;
        else if (text.includes("down")) y += dist;
        await ctx.mouse.moveMouse(x, y);
      },
      pattern: "nudge {dir:dir} [{n:number}]",
    }),

    // ─── Mark → drag ─────────────────────────────────────────────────────────
    command({
      name: "mark",
      phrase: "mark",
      description: "Mark current gaze position as drag start",
      run: (ctx) => {
        ctx.state.markPoint = ctx.target();
        ctx.log(`[voice] marked at ${JSON.stringify(ctx.state.markPoint)}`);
      },
    }),

    command({
      name: "drag-here",
      phrase: "drag here",
      description: "Drag from marked point to current gaze position",
      run: async (ctx) => {
        const from = ctx.state.markPoint;
        const to = ctx.target();
        if (!from || !to || !ctx.mouse) {
          ctx.log("[voice] drag here: no mark or no target");
          return;
        }
        await ctx.mouse.moveMouse(from.x, from.y);
        // Simulate drag: move with mouse button held (not directly supported in MouseMover)
        // Use underlying computer service if available
        const actions = ctx.services.platform;
        const drag = (actions as { dragMouse?: (a: Point, b: Point) => Promise<void> } | undefined)?.dragMouse;
        if (drag) {
          await drag.call(actions, from, to);
        } else {
          // Fallback: just click at destination
          await ctx.mouse.moveMouse(to.x, to.y);
        }
        ctx.state.markPoint = undefined;
      },
    }),

    // ─── Select from here → to here ──────────────────────────────────────────
    command({
      name: "select-from-here",
      phrase: "select from here",
      description: "Click at current gaze position (start of selection)",
      run: async (ctx) => {
        const pos = ctx.target();
        if (pos && ctx.mouse) {
          await ctx.mouse.clickAt(pos.x, pos.y, "left");
          ctx.state.selectFromPoint = pos;
        }
      },
    }),

    command({
      name: "to-here",
      phrase: "to here",
      description: "Shift-click at current gaze position (end of selection)",
      run: async (ctx) => {
        const pos = ctx.target();
        if (pos && ctx.mouse) {
          // Shift+click: move then shift-click
          await ctx.mouse.moveMouse(pos.x, pos.y);
          const actions = ctx.services.platform;
          if (actions) await actions.pressCombo("shift+click");
          else await ctx.mouse.clickAt(pos.x, pos.y, "left");
          ctx.state.selectFromPoint = undefined;
        }
      },
    }),

    // ─── Scroll ──────────────────────────────────────────────────────────────
    // Wheel events go to whatever is under the pointer, so every scroll first
    // puts the pointer at the gaze target (actions.scroll does that when given
    // a point). Continuous scrolling positions the pointer once, then leaves
    // it alone so you can still move the mouse while it runs.
    command({
      name: "scroll-up",
      phrase: "scroll up",
      description: 'Scroll up where you\'re looking ("scroll up 3" = 3 times)',
      run: async (ctx) => {
        stopContinuousScroll(ctx);
        await scrollAt(ctx, 0, -SCROLL_STEP_LINES, ctx.target());
      },
      aliases: ["scroll up", "scroll it up"],
      repeatable: true,
      pattern: "scroll up [{n:number}]",
    }),

    command({
      name: "scroll-down",
      phrase: "scroll down",
      description: 'Scroll down where you\'re looking ("scroll down 3" = 3 times)',
      run: async (ctx) => {
        stopContinuousScroll(ctx);
        await scrollAt(ctx, 0, SCROLL_STEP_LINES, ctx.target());
      },
      aliases: ["scroll down", "scroll it down"],
      repeatable: true,
      pattern: "scroll down [{n:number}]",
    }),

    command({
      name: "scroll-left",
      phrase: "scroll left",
      description: "Scroll left where you're looking",
      run: async (ctx) => {
        await scrollAt(ctx, -SCROLL_STEP_LINES, 0, ctx.target());
      },
      repeatable: true,
    }),

    command({
      name: "scroll-right",
      phrase: "scroll right",
      description: "Scroll right where you're looking",
      run: async (ctx) => {
        await scrollAt(ctx, SCROLL_STEP_LINES, 0, ctx.target());
      },
      repeatable: true,
    }),

    command({
      name: "page-down",
      phrase: "page down",
      description: "Scroll one page down",
      run: async (ctx) => {
        const actions = ctx.services.platform;
        if (actions) await actions.pressCombo("pagedown");
      },
      repeatable: true,
    }),

    command({
      name: "page-up",
      phrase: "page up",
      description: "Scroll one page up",
      run: async (ctx) => {
        const actions = ctx.services.platform;
        if (actions) await actions.pressCombo("pageup");
      },
      repeatable: true,
    }),

    command({
      name: "keep-scrolling",
      phrase: "keep scrolling",
      description: 'Auto-scroll down until "stop" (also: keep scrolling up / slow / fast)',
      run: async (ctx) => {
        const text = ctx.text.toLowerCase();
        const dir = /\bup\b/.test(text) ? -1 : 1;
        const speed = /slow/.test(text) ? "slow" : /fast|quick/.test(text) ? "fast" : "medium";
        await startContinuousScroll(ctx, dir, speed);
      },
      aliases: [
        "keep scrolling down",
        "keep scrolling up",
        "keep scrolling slow",
        "keep scrolling slowly",
        "keep scrolling fast",
        "auto scroll",
        "start scrolling",
      ],
    }),

    command({
      name: "slow-scroll-down",
      phrase: "slowly scroll down",
      description: 'Slow auto-scroll down for reading, until "stop"',
      run: async (ctx) => {
        await startContinuousScroll(ctx, 1, "slow");
      },
      aliases: ["scroll down slowly", "slow scroll down", "slow scroll", "scroll slowly", "slowly scroll"],
    }),

    command({
      name: "slow-scroll-up",
      phrase: "slowly scroll up",
      description: 'Slow auto-scroll up, until "stop"',
      run: async (ctx) => {
        await startContinuousScroll(ctx, -1, "slow");
      },
      aliases: ["scroll up slowly", "slow scroll up"],
    }),

    command({
      name: "scroll-faster",
      phrase: "faster",
      description: "Speed up auto-scroll",
      run: (ctx) => {
        const scroll = ctx.state.scroll;
        if (!scroll) return ctx.log("[voice] faster: not auto-scrolling");
        scroll.linesPerTick = Math.min(12, scroll.linesPerTick + 1);
        ctx.log(`[voice] auto-scroll speed ${scroll.linesPerTick}`);
      },
      aliases: ["scroll faster", "speed up"],
    }),

    command({
      name: "scroll-slower",
      phrase: "slower",
      description: "Slow down auto-scroll",
      run: (ctx) => {
        const scroll = ctx.state.scroll;
        if (!scroll) return ctx.log("[voice] slower: not auto-scrolling");
        if (scroll.linesPerTick > 1) scroll.linesPerTick -= 1;
        else scroll.tickMs = Math.min(600, Math.round(scroll.tickMs * 1.5));
        ctx.log(`[voice] auto-scroll speed ${scroll.linesPerTick} line(s) / ${scroll.tickMs}ms`);
      },
      aliases: ["scroll slower", "slow down"],
    }),

    command({
      name: "stop-scrolling",
      phrase: "stop scrolling",
      description: "Stop auto-scroll",
      run: (ctx) => {
        const was = !!ctx.state.scroll;
        stopContinuousScroll(ctx);
        ctx.log(was ? "[voice] stopped scrolling" : "[voice] stop: not scrolling");
      },
      aliases: ["stop", "stop scroll", "stop scrolling down", "stop scrolling up"],
    }),

    command({
      name: "recenter",
      phrase: "recenter",
      description: "Quick gaze offset correction",
      run: async (ctx) => {
        try {
          await ctx.services.gaze.recenter();
          ctx.log("[voice] recenter requested");
        } catch {
          ctx.log("[voice] recenter: eye tracker not available");
        }
      },
    }),
  ],
});

export default GAZE_MOUSE_PACK;
