/**
 * Gaze mouse pack: eye-tracking mouse control, clicks, scroll, nudge, mark/drag.
 * Covers commands.md §2.
 */

import type { VoiceCommandExtension, VoiceCommandContext } from "../voiceCommands";
import { VOICE_COMMAND_EXTENSION } from "../voiceCommands";
import { clickTarget, doubleClickTarget, recentPlacedCandidate } from "../pointerMemory";

/** Lazily stop the smart mouse to avoid circular imports. */
function tryStopSmartMouse(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const hints = require("./hints");
    hints.stopSmartMouse?.();
  } catch {
    // hints not loaded — that's fine
  }
}

function cmd(
  name: string,
  phrase: string,
  description: string,
  run: VoiceCommandExtension["run"],
  extras: Partial<VoiceCommandExtension> = {},
): VoiceCommandExtension {
  return {
    type: VOICE_COMMAND_EXTENSION,
    name: `voice-control.gaze.${name}`,
    phrase,
    description,
    run,
    modes: ["command"],
    ...extras,
  };
}

/** Stored mark point for mark→drag. */
let markPoint: { x: number; y: number } | undefined;

/** Stored "select from here" point. */
let selectFromPoint: { x: number; y: number } | undefined;

/** Wheel lines per "scroll up/down". */
const SCROLL_STEP_LINES = 5;

/** Continuous (auto) scroll state. */
interface ScrollState {
  timer: NodeJS.Timeout;
  dir: 1 | -1;
  linesPerTick: number;
  tickMs: number;
  busy: boolean;
}
let scrollState: ScrollState | undefined;

function stopContinuousScroll(): void {
  if (scrollState) {
    clearTimeout(scrollState.timer);
    scrollState = undefined;
  }
}

async function scrollAt(
  ctx: VoiceCommandContext,
  dx: number,
  dy: number,
  at?: { x: number; y: number } | null,
): Promise<void> {
  const actions = (ctx as any).actions;
  if (!actions) return ctx.log("[voice] scroll: no platform actions available");
  await actions.scroll(dx, dy, at ?? undefined);
}

const SCROLL_SPEEDS = {
  slow: { linesPerTick: 1, tickMs: 160 },
  medium: { linesPerTick: 2, tickMs: 120 },
  fast: { linesPerTick: 5, tickMs: 120 },
} as const;

async function startContinuousScroll(
  ctx: VoiceCommandContext,
  dir: 1 | -1,
  speed: keyof typeof SCROLL_SPEEDS,
): Promise<void> {
  stopContinuousScroll();
  // Put the pointer over the gaze target once, then scroll in place.
  await scrollAt(ctx, 0, 0, ctx.target());
  const state: ScrollState = {
    timer: undefined as unknown as NodeJS.Timeout,
    dir,
    ...SCROLL_SPEEDS[speed],
    busy: false,
  };
  const tick = async () => {
    if (scrollState !== state) return;
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
    if (scrollState === state) {
      state.timer = setTimeout(tick, state.tickMs);
      state.timer.unref?.();
    }
  };
  scrollState = state;
  state.timer = setTimeout(tick, 0);
  state.timer.unref?.();
  ctx.log(`[voice] auto-scrolling ${dir > 0 ? "down" : "up"} (${speed}); say "stop" to stop, "faster"/"slower" to adjust`);
}

export const GAZE_MOUSE_PACK: VoiceCommandExtension[] = [
  // ─── Gaze-follow control ──────────────────────────────────────────────────
  cmd(
    "eye-control-mouse",
    "eye control mouse",
    "Start moving the mouse pointer with your gaze",
    (ctx) => {
      ctx.gazeFollow?.start();
      console.log("[voice] gaze mouse ON");
    },
    { aliases: ["gaze mouse", "follow my eyes", "eyecontrol mouse", "eye control", "eye mouse", "i mouse"] },
  ),

  cmd(
    "stop-mouse",
    "stop mouse",
    "Stop gaze-controlled mouse movement",
    (ctx) => {
      ctx.gazeFollow?.stop();
      tryStopSmartMouse();
      console.log("[voice] gaze mouse OFF");
    },
    { aliases: ["stop eye control", "stop gaze", "stop following", "mouse off", "freeze"] },
  ),

  cmd(
    "toggle-mouse",
    "toggle mouse",
    "Toggle gaze-controlled mouse movement",
    (ctx) => {
      if (ctx.gazeFollow?.isRunning()) {
        ctx.gazeFollow.stop();
        tryStopSmartMouse();
        console.log("[voice] gaze mouse OFF");
      } else {
        ctx.gazeFollow?.start();
        console.log("[voice] gaze mouse ON");
      }
    },
  ),

  // ─── Clicks ──────────────────────────────────────────────────────────────
  cmd(
    "mouse-here",
    "mouse here",
    "Move the pointer once to where you're looking (no click)",
    async (ctx) => {
      const pos = ctx.target();
      if (!pos) return ctx.log("[voice] mouse here: no gaze point");
      if (ctx.mouse) await ctx.mouse.moveMouse(pos.x, pos.y);
    },
    { aliases: ["move mouse here", "move the mouse here", "mouse over here", "move mouse", "cursor here", "hover here"] },
  ),

  cmd(
    "click",
    "click",
    "Left-click the pointer a hint just placed, else where you are looking. If a 'mouse over' command recently hovered an AX element, AXPresses it.",
    async (ctx) => {
      // If we have a remembered AX candidate from a recent "mouse over <hint>",
      // prefer AXPress over a coordinate click (Spotify hover-only play buttons).
      const remembered = recentPlacedCandidate();
      if (remembered) {
        try {
          const { activateElement, getComputerService } = require("../smartSelector");
          const cu = (require("../computerService") as any).getComputerService?.();
          if (cu) {
            await activateElement(cu, remembered, "click");
            return;
          }
        } catch { /* fall through to coordinate click */ }
      }
      const pos = clickTarget(ctx);
      if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "left");
    },
    { minVoicedMs: 100, maxAudioMs: 2500, aliases: ["click that", "click it", "click here", "click there", "click click", "clique"] } as any,
  ),

  cmd(
    "double-click",
    "double click",
    "Double-click where you are looking. If a 'mouse over' command recently hovered an AX element, tries to play it.",
    async (ctx) => {
      // If we have a remembered AX candidate from a recent "mouse over <hint>",
      // prefer AXPress (or find the row's play button for Spotify rows).
      const remembered = recentPlacedCandidate();
      if (remembered) {
        try {
          const { activateElement, findPlayButton, getComputerService } = require("../smartSelector");
          const cu = (require("../computerService") as any).getComputerService?.();
          if (cu) {
            const el = remembered.element;
            // For Spotify AXRow: try to find and AXPress the row's play button
            if (el.role === "AXRow" && el.bounds) {
              const rowName = (el.title ?? el.description ?? "").toLowerCase();
              const songWords = rowName.split(/\s+/).slice(0, 6).filter(Boolean);
              if (songWords.length) {
                const playBtn = await findPlayButton(cu, songWords, {
                  x: el.bounds.x + el.bounds.width / 2,
                  y: el.bounds.y + el.bounds.height / 2,
                });
                if (playBtn) {
                  await activateElement(cu, playBtn, "click");
                  return;
                }
              }
              // Fallback: double-click the row centre
              const cx = Math.round(el.bounds.x + el.bounds.width / 2);
              const cy = Math.round(el.bounds.y + el.bounds.height / 2);
              await cu.moveMouse({ x: cx, y: cy });
              await cu.click("left", { double: true });
              return;
            }
            // Buttons/links: one AXPress is the "open/play" (a real double
            // click would toggle a play button twice). Anything else (cells,
            // images, files, screenshot text) gets a real double-click where
            // the mouse-over left the pointer — never at the gaze point.
            if (el.role === "AXButton" || el.role === "AXLink") {
              await activateElement(cu, remembered, "click");
              return;
            }
          }
        } catch { /* fall through to coordinate double-click */ }
      }
      // A recent "mouse over X" put the pointer on X: double-click there, even
      // if your eyes have moved on. Only otherwise use the gaze point.
      const pos = doubleClickTarget(ctx);
      if (pos && ctx.mouse) await ctx.mouse.doubleClickAt(pos.x, pos.y);
    },
    { aliases: ["doubleclick", "double click that", "double click it", "double click here", "double click there", "double-click that", "double-click it", "double-click here"] },
  ),

  cmd(
    "right-click",
    "right click",
    "Right-click where you are looking",
    async (ctx) => {
      const pos = clickTarget(ctx);
      if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "right");
    },
    { aliases: ["rightclick"] },
  ),

  cmd(
    "triple-click",
    "triple click",
    "Triple-click where you are looking",
    async (ctx) => {
      const pos = ctx.target();
      if (pos && ctx.mouse) {
        await ctx.mouse.clickAt(pos.x, pos.y, "left");
        await ctx.mouse.clickAt(pos.x, pos.y, "left");
        await ctx.mouse.clickAt(pos.x, pos.y, "left");
      }
    },
  ),

  cmd(
    "command-click",
    "command click",
    "Command-click (Cmd+Click) where you are looking",
    async (ctx) => {
      const pos = ctx.target();
      const actions = (ctx as any).actions;
      if (pos && actions) {
        await ctx.mouse?.moveMouse(pos.x, pos.y);
        await actions.pressCombo("mod+click");
      } else if (pos && ctx.mouse) {
        // fallback: move then click without modifier
        await ctx.mouse.clickAt(pos.x, pos.y, "left");
      }
    },
  ),

  cmd(
    "shift-click",
    "shift click",
    "Shift-click where you are looking",
    async (ctx) => {
      const pos = ctx.target();
      if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "left");
    },
  ),

  cmd(
    "option-click",
    "option click",
    "Option-click where you are looking",
    async (ctx) => {
      const pos = ctx.target();
      if (pos && ctx.mouse) await ctx.mouse.clickAt(pos.x, pos.y, "left");
    },
    { aliases: ["alt click"] },
  ),

  // ─── Nudge ───────────────────────────────────────────────────────────────
  cmd(
    "nudge",
    "nudge",
    "Nudge pointer 20px in a direction",
    async (ctx) => {
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
    { pattern: "nudge {dir:dir} [{n:number}]" } as any,
  ),

  // ─── Mark → drag ─────────────────────────────────────────────────────────
  cmd(
    "mark",
    "mark",
    "Mark current gaze position as drag start",
    (ctx) => {
      markPoint = ctx.target();
      ctx.log(`[voice] marked at ${JSON.stringify(markPoint)}`);
    },
  ),

  cmd(
    "drag-here",
    "drag here",
    "Drag from marked point to current gaze position",
    async (ctx) => {
      const from = markPoint;
      const to = ctx.target();
      if (!from || !to || !ctx.mouse) {
        ctx.log("[voice] drag here: no mark or no target");
        return;
      }
      await ctx.mouse.moveMouse(from.x, from.y);
      // Simulate drag: move with mouse button held (not directly supported in MouseMover)
      // Use underlying computer service if available
      const actions = (ctx as any).actions;
      if (actions?.dragMouse) {
        await actions.dragMouse(from, to);
      } else {
        // Fallback: just click at destination
        await ctx.mouse.moveMouse(to.x, to.y);
      }
      markPoint = undefined;
    },
  ),

  // ─── Select from here → to here ──────────────────────────────────────────
  cmd(
    "select-from-here",
    "select from here",
    "Click at current gaze position (start of selection)",
    async (ctx) => {
      const pos = ctx.target();
      if (pos && ctx.mouse) {
        await ctx.mouse.clickAt(pos.x, pos.y, "left");
        selectFromPoint = pos;
      }
    },
  ),

  cmd(
    "to-here",
    "to here",
    "Shift-click at current gaze position (end of selection)",
    async (ctx) => {
      const pos = ctx.target();
      if (pos && ctx.mouse) {
        // Shift+click: move then shift-click
        await ctx.mouse.moveMouse(pos.x, pos.y);
        const actions = (ctx as any).actions;
        if (actions) await actions.pressCombo("shift+click");
        else await ctx.mouse.clickAt(pos.x, pos.y, "left");
        selectFromPoint = undefined;
      }
    },
  ),

  // ─── Scroll ──────────────────────────────────────────────────────────────
  // Wheel events go to whatever is under the pointer, so every scroll first
  // puts the pointer at the gaze target (actions.scroll does that when given
  // a point). Continuous scrolling positions the pointer once, then leaves
  // it alone so you can still move the mouse while it runs.
  cmd(
    "scroll-up",
    "scroll up",
    "Scroll up where you're looking (\"scroll up 3\" = 3 times)",
    async (ctx) => {
      stopContinuousScroll();
      await scrollAt(ctx, 0, -SCROLL_STEP_LINES, ctx.target());
    },
    { aliases: ["scroll up", "scroll it up"], repeatable: true, pattern: "scroll up [{n:number}]" } as any,
  ),

  cmd(
    "scroll-down",
    "scroll down",
    "Scroll down where you're looking (\"scroll down 3\" = 3 times)",
    async (ctx) => {
      stopContinuousScroll();
      await scrollAt(ctx, 0, SCROLL_STEP_LINES, ctx.target());
    },
    { aliases: ["scroll down", "scroll it down"], repeatable: true, pattern: "scroll down [{n:number}]" } as any,
  ),

  cmd(
    "scroll-left",
    "scroll left",
    "Scroll left where you're looking",
    async (ctx) => {
      await scrollAt(ctx, -SCROLL_STEP_LINES, 0, ctx.target());
    },
    { repeatable: true } as any,
  ),

  cmd(
    "scroll-right",
    "scroll right",
    "Scroll right where you're looking",
    async (ctx) => {
      await scrollAt(ctx, SCROLL_STEP_LINES, 0, ctx.target());
    },
    { repeatable: true } as any,
  ),

  cmd(
    "page-down",
    "page down",
    "Scroll one page down",
    async (ctx) => {
      const actions = (ctx as any).actions;
      if (actions) await actions.pressCombo("pagedown");
    },
    { repeatable: true } as any,
  ),

  cmd(
    "page-up",
    "page up",
    "Scroll one page up",
    async (ctx) => {
      const actions = (ctx as any).actions;
      if (actions) await actions.pressCombo("pageup");
    },
    { repeatable: true } as any,
  ),

  cmd(
    "keep-scrolling",
    "keep scrolling",
    "Auto-scroll down until \"stop\" (also: keep scrolling up / slow / fast)",
    async (ctx) => {
      const text = ctx.text.toLowerCase();
      const dir = /\bup\b/.test(text) ? -1 : 1;
      const speed = /slow/.test(text) ? "slow" : /fast|quick/.test(text) ? "fast" : "medium";
      await startContinuousScroll(ctx, dir, speed);
    },
    {
      aliases: [
        "keep scrolling down",
        "keep scrolling up",
        "keep scrolling slow",
        "keep scrolling slowly",
        "keep scrolling fast",
        "auto scroll",
        "start scrolling",
      ],
    },
  ),

  cmd(
    "slow-scroll-down",
    "slowly scroll down",
    "Slow auto-scroll down for reading, until \"stop\"",
    async (ctx) => {
      await startContinuousScroll(ctx, 1, "slow");
    },
    { aliases: ["scroll down slowly", "slow scroll down", "slow scroll", "scroll slowly", "slowly scroll"] },
  ),

  cmd(
    "slow-scroll-up",
    "slowly scroll up",
    "Slow auto-scroll up, until \"stop\"",
    async (ctx) => {
      await startContinuousScroll(ctx, -1, "slow");
    },
    { aliases: ["scroll up slowly", "slow scroll up"] },
  ),

  cmd(
    "scroll-faster",
    "faster",
    "Speed up auto-scroll",
    (ctx) => {
      if (!scrollState) return ctx.log("[voice] faster: not auto-scrolling");
      scrollState.linesPerTick = Math.min(12, scrollState.linesPerTick + 1);
      ctx.log(`[voice] auto-scroll speed ${scrollState.linesPerTick}`);
    },
    { aliases: ["scroll faster", "speed up"] },
  ),

  cmd(
    "scroll-slower",
    "slower",
    "Slow down auto-scroll",
    (ctx) => {
      if (!scrollState) return ctx.log("[voice] slower: not auto-scrolling");
      if (scrollState.linesPerTick > 1) scrollState.linesPerTick -= 1;
      else scrollState.tickMs = Math.min(600, Math.round(scrollState.tickMs * 1.5));
      ctx.log(`[voice] auto-scroll speed ${scrollState.linesPerTick} line(s) / ${scrollState.tickMs}ms`);
    },
    { aliases: ["scroll slower", "slow down"] },
  ),

  cmd(
    "stop-scrolling",
    "stop scrolling",
    "Stop auto-scroll",
    (ctx) => {
      const was = !!scrollState;
      stopContinuousScroll();
      ctx.log(was ? "[voice] stopped scrolling" : "[voice] stop: not scrolling");
    },
    { aliases: ["stop", "stop scroll", "stop scrolling down", "stop scrolling up"] },
  ),

  cmd(
    "recenter",
    "recenter",
    "Quick gaze offset correction",
    async (ctx) => {
      const hubUrl = (ctx as any).hubUrl as string | undefined;
      if (hubUrl) {
        try {
          await fetch(`${hubUrl}/api/gaze/recenter`, { method: "POST" });
          ctx.log("[voice] recenter requested");
        } catch {
          ctx.log("[voice] recenter: eye tracker not available");
        }
      } else {
        ctx.log("[voice] recenter: no hub URL configured");
      }
    },
  ),
];

export default GAZE_MOUSE_PACK;
