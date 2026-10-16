/**
 * System pack — volume, media, screenshot, spotlight, lock screen, mission control.
 *
 * Commands per commands.md §9.
 */

import type { PackCommandContext } from "./define";
import { defineVoicePack } from "./define";
import type { PlatformActions } from "../actions/types";

// Use VoiceCommandContext directly (slots, repeat, actions are defined there)
type ExtendedCtx = PackCommandContext;

function getActions(ctx: ExtendedCtx): PlatformActions {
  return ctx.actions ?? ctx.services.platform;
}

function slot(ctx: ExtendedCtx, key: string): string | undefined {
  const v = ctx.slots?.[key];
  return v !== undefined ? String(v) : undefined;
}

function slotNum(ctx: ExtendedCtx, key: string, def = 1): number {
  const v = slot(ctx, key);
  if (!v) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

// ─── Pack ─────────────────────────────────────────────────────────────────────

export const SYSTEM_PACK = defineVoicePack({
  name: "system",
  description: "Volume, media, screenshot, spotlight, lock screen, mission control",
  prefix: "system.",
  commands: ({ command }) => [
    // ── Volume ───────────────────────────────────────────────────────────────
    command({
      name: "volume-up",
      phrase: "volume up",
      description: "Increase system volume",
      run: async (ctx) => {
        const n = Math.max(1, ctx.repeat ?? slotNum(ctx, "n", 1));
        for (let i = 0; i < n; i++) {
          await getActions(ctx).systemAction("volume-up");
        }
      },
      aliases: ["louder"],
      patterns: ["volume up [n:number]", "volume up"],
      repeatable: true,
    }),

    command({
      name: "volume-down",
      phrase: "volume down",
      description: "Decrease system volume",
      run: async (ctx) => {
        const n = Math.max(1, ctx.repeat ?? slotNum(ctx, "n", 1));
        for (let i = 0; i < n; i++) {
          await getActions(ctx).systemAction("volume-down");
        }
      },
      aliases: ["quieter"],
      patterns: ["volume down [n:number]", "volume down"],
      repeatable: true,
    }),

    command({
      name: "mute",
      phrase: "mute",
      description: "Mute / unmute system audio",
      run: async (ctx) => {
        await getActions(ctx).systemAction("mute");
      },
      aliases: ["unmute", "toggle mute"],
    }),

    // ── Media controls ────────────────────────────────────────────────────────
    command({
      name: "play",
      phrase: "play",
      description: "Play media",
      run: async (ctx) => {
        await getActions(ctx).systemAction("play-pause");
      },
      aliases: ["play music", "resume"],
    }),

    command({
      name: "pause",
      phrase: "pause",
      description: "Pause media",
      run: async (ctx) => {
        await getActions(ctx).systemAction("play-pause");
      },
      aliases: ["pause music", "pause playback"],
    }),

    command({
      name: "play-pause",
      phrase: "play pause",
      description: "Toggle play/pause",
      run: async (ctx) => {
        await getActions(ctx).systemAction("play-pause");
      },
    }),

    command({
      name: "next-track",
      phrase: "next track",
      description: "Skip to next track",
      run: async (ctx) => {
        await getActions(ctx).systemAction("next-track");
      },
      aliases: ["next song", "skip"],
    }),

    command({
      name: "previous-track",
      phrase: "previous track",
      description: "Go to previous track",
      run: async (ctx) => {
        await getActions(ctx).systemAction("previous-track");
      },
      aliases: ["previous song", "last track"],
    }),

    // ── Screenshot ────────────────────────────────────────────────────────────
    command({
      name: "screenshot",
      phrase: "screenshot",
      description: "Take a screenshot",
      run: async (ctx) => {
        const what = slot(ctx, "what");
        const actions = getActions(ctx);
        if (what === "window" || what === "here") {
          // Try to screenshot the window under gaze / front window
          const pos = ctx.target();
          if (pos) {
            const win = await actions.windowAt(pos);
            if (win?.id) {
              // Use screencapture -l <windowId>
              const { execFile } = await import("child_process");
              const { promisify } = await import("util");
              const execFileAsync = promisify(execFile);
              const outPath = `${process.env.HOME ?? "~"}/Desktop/screenshot-${Date.now()}.png`;
              await execFileAsync("/usr/sbin/screencapture", ["-x", "-l", String(win.id), outPath]).catch(() =>
                actions.systemAction("screenshot")
              );
              return;
            }
          }
        }
        await actions.systemAction("screenshot");
      },
      patterns: ["screenshot [window]", "screenshot [here]", "screenshot"],
      platforms: ["darwin"],
    }),

    // ── Spotlight ─────────────────────────────────────────────────────────────
    command({
      name: "spotlight",
      phrase: "spotlight {text:text}",
      description: "Open Spotlight and search for text",
      run: async (ctx) => {
        const text = slot(ctx, "text") ?? "";
        const actions = getActions(ctx);
        await actions.systemAction("spotlight");
        if (text) {
          // Small delay for Spotlight to open
          await ctx.services.clock.sleep(400);
          await actions.typeText(text);
        }
      },
      patterns: ["spotlight {text:text}", "spotlight"],
      platforms: ["darwin"],
    }),

    // ── Lock screen ────────────────────────────────────────────────────────────
    command({
      name: "lock-screen",
      phrase: "lock screen",
      description: "Lock the screen (asks for confirmation)",
      run: async (ctx) => {
        await getActions(ctx).systemAction("lock-screen");
      },
      risk: "confirm",
      platforms: ["darwin"],
    }),

    // ── Mission control / show desktop ────────────────────────────────────────
  ],
});
