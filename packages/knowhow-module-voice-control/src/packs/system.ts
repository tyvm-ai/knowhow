/**
 * System pack — volume, media, screenshot, spotlight, lock screen, mission control.
 *
 * Commands per commands.md §9.
 */

import { VoiceCommandExtension, VoiceCommandContext } from "../voiceCommands";
import { getPlatformActions } from "../actions/index";
import type { PlatformActions } from "../actions/types";

// Use VoiceCommandContext directly (slots, repeat, actions are defined there)
type ExtendedCtx = VoiceCommandContext;

function getActions(ctx: ExtendedCtx): PlatformActions {
  return ctx.actions ?? getPlatformActions();
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

function cmd(
  name: string,
  phrase: string,
  description: string,
  run: (ctx: ExtendedCtx) => void | Promise<void>,
  opts: Partial<Omit<VoiceCommandExtension, "type" | "name" | "phrase" | "description" | "run">> = {},
): VoiceCommandExtension {
  return {
    type: "voice-control.command",
    name: `system.${name}`,
    phrase,
    description,
    run: run as VoiceCommandExtension["run"],
    ...opts,
  };
}

// ─── Pack ─────────────────────────────────────────────────────────────────────

export const SYSTEM_PACK: VoiceCommandExtension[] = [
  // ── Volume ───────────────────────────────────────────────────────────────
  cmd("volume-up", "volume up", "Increase system volume", async (ctx) => {
    const n = Math.max(1, ctx.repeat ?? slotNum(ctx, "n", 1));
    for (let i = 0; i < n; i++) {
      await getActions(ctx).systemAction("volume-up");
    }
  }, {
    aliases: ["louder"],
    patterns: ["volume up [n:number]", "volume up"],
    repeatable: true,
  } as any),

  cmd("volume-down", "volume down", "Decrease system volume", async (ctx) => {
    const n = Math.max(1, ctx.repeat ?? slotNum(ctx, "n", 1));
    for (let i = 0; i < n; i++) {
      await getActions(ctx).systemAction("volume-down");
    }
  }, {
    aliases: ["quieter"],
    patterns: ["volume down [n:number]", "volume down"],
    repeatable: true,
  } as any),

  cmd("mute", "mute", "Mute / unmute system audio", async (ctx) => {
    await getActions(ctx).systemAction("mute");
  }, {
    aliases: ["unmute", "toggle mute"],
  }),

  // ── Media controls ────────────────────────────────────────────────────────
  cmd("play", "play", "Play media", async (ctx) => {
    await getActions(ctx).systemAction("play-pause");
  }, { aliases: ["play music", "resume"] }),

  cmd("pause", "pause", "Pause media", async (ctx) => {
    await getActions(ctx).systemAction("play-pause");
  }, { aliases: ["pause music", "pause playback"] }),

  cmd("play-pause", "play pause", "Toggle play/pause", async (ctx) => {
    await getActions(ctx).systemAction("play-pause");
  }),

  cmd("next-track", "next track", "Skip to next track", async (ctx) => {
    await getActions(ctx).systemAction("next-track");
  }, { aliases: ["next song", "skip"] }),

  cmd("previous-track", "previous track", "Go to previous track", async (ctx) => {
    await getActions(ctx).systemAction("previous-track");
  }, { aliases: ["previous song", "last track"] }),

  // ── Screenshot ────────────────────────────────────────────────────────────
  cmd("screenshot", "screenshot", "Take a screenshot", async (ctx) => {
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
  }, {
    patterns: ["screenshot [window]", "screenshot [here]", "screenshot"],
    platforms: ["darwin"],
  } as any),

  // ── Spotlight ─────────────────────────────────────────────────────────────
  cmd("spotlight", "spotlight {text:text}", "Open Spotlight and search for text", async (ctx) => {
    const text = slot(ctx, "text") ?? "";
    const actions = getActions(ctx);
    await actions.systemAction("spotlight");
    if (text) {
      // Small delay for Spotlight to open
      await new Promise<void>((r) => setTimeout(r, 400));
      await actions.typeText(text);
    }
  }, {
    patterns: ["spotlight {text:text}", "spotlight"],
    platforms: ["darwin"],
  } as any),

  // ── Lock screen ────────────────────────────────────────────────────────────
  cmd("lock-screen", "lock screen", "Lock the screen (asks for confirmation)", async (ctx) => {
    await getActions(ctx).systemAction("lock-screen");
  }, {
    risk: "confirm",
    platforms: ["darwin"],
  } as any),

  // ── Mission control / show desktop ────────────────────────────────────────
  cmd("mission-control", "mission control", "Show Mission Control", async (ctx) => {
    await getActions(ctx).systemAction("mission-control");
  }, {
    platforms: ["darwin"],
  } as any),

  cmd("show-desktop", "show desktop", "Show the desktop (Mission Control show-desktop)", async (ctx) => {
    await getActions(ctx).systemAction("show-desktop");
  }, {
    platforms: ["darwin"],
  } as any),
];
