/**
 * Meta pack: modes, what-can-I-say, cancel, repeat, confirm, undo, pause.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { defineVoicePack } from "./define";

export const META_PACK = defineVoicePack({
  name: "meta",
  description: "Modes, what-can-I-say, cancel, repeat, confirm, redo, undo, pause",
  prefix: "voice-control.meta.",
  commands: ({ command }) => [
    command({
      name: "what-can-i-say",
      phrase: "what can I say",
      description: "Show overlay of available commands",
      run: (ctx) => {
        ctx.log("[voice] show commands overlay");
        // Print to terminal
        const registered = (ctx as any).commands as VoiceCommandExtension[] | undefined;
        if (registered?.length) {
          console.log("\n[voice] Available commands:");
          for (const c of registered.slice(0, 40)) {
            console.log(`  ${c.phrase}${c.description ? " — " + c.description : ""}`);
          }
        }
      },
      aliases: [
        "show commands",
        "help",
        "what commands",
        "list commands",
        "what commands do we have",
        "what commands do i have",
        "commands",
      ],
      modes: ["command", "agent"],
    }),

    command({
      name: "hide-commands",
      phrase: "hide commands",
      description: "Hide the commands overlay",
      run: (ctx) => {
        ctx.log("[voice] hide commands overlay");
      },
      modes: ["command", "agent"],
    }),

    command({
      name: "cancel",
      phrase: "cancel",
      description: "Cancel pending action or chain",
      run: async (ctx) => {
        const pending = ctx.services.pending.take();
        if (pending) {
          ctx.log(`[voice] cancel: ${pending.describe}`);
          await pending.reject();
        } else {
          ctx.log("[voice] cancel");
        }
      },
      aliases: ["never mind", "nevermind", "abort", "no", "reject"],
    }),

    command({
      name: "confirm",
      phrase: "confirm",
      description: "Confirm a pending risky action",
      run: async (ctx) => {
        const pending = ctx.services.pending.take();
        if (pending) {
          ctx.log(`[voice] confirm: ${pending.describe}`);
          await pending.accept();
        } else {
          ctx.log("[voice] confirm pending action");
        }
      },
      aliases: ["type it", "yes", "do it"],
    }),

    command({
      name: "repeat",
      phrase: "repeat",
      description: "Repeat the last command",
      run: (ctx) => {
        ctx.log("[voice] repeat last command");
      },
      aliases: ["again", "do it again"],
      repeatable: false,
    }),

    command({
      name: "redo",
      phrase: "redo",
      patterns: ["redo", "redo {n:number}"],
      description: "Redo / regenerate the last pending action; 'redo 3' presses Redo (Cmd-Shift-Z) that many times",
      run: async (ctx) => {
        // "redo <n>" is the editor shortcut (it used to live in the keys pack).
        if (ctx.slots.n !== undefined) {
          const n = typeof ctx.slots.n === "number" ? ctx.slots.n : parseInt(String(ctx.slots.n), 10) || 1;
          await ctx.actions?.pressCombo("mod+shift+z", { repeat: n });
          return;
        }
        const pending = ctx.services.pending.take();
        if (pending?.redo) {
          ctx.log(`[voice] redo: ${pending.describe}`);
          await pending.redo();
        } else if (pending) {
          ctx.log("[voice] redo: no redo available, cancelling");
          await pending.reject();
        } else {
          ctx.log("[voice] redo: nothing pending");
        }
      },
      aliases: ["try again"],
    }),

    command({
      name: "undo-that",
      phrase: "undo that",
      description: "Undo the last reversible voice action",
      run: async (ctx) => {
        const history = ctx.history as
          | Array<{
              type: string;
              win?: { app: string; bounds: { x: number; y: number; width: number; height: number } };
              bounds?: { x: number; y: number; width: number; height: number };
            }>
          | undefined;
        if (!history || history.length === 0) {
          ctx.log("[voice] undo that: nothing to undo");
          return;
        }
        const record = history.pop();
        if (!record) return;
        if (record.type === "window-bounds" && record.win && record.bounds && ctx.actions) {
          ctx.log(`[voice] undo: restoring window bounds for ${record.win.app}`);
          await ctx.actions.setWindowBounds(record.win as any, record.bounds);
        } else {
          ctx.log(`[voice] undo: no handler for type "${record?.type ?? "unknown"}"`);
        }
      },
      aliases: ["revert that"],
    }),

    command({
      name: "pause-voice",
      phrase: "pause voice",
      description: "Pause voice command mode temporarily",
      run: (ctx) => {
        ctx.log("[voice] pausing voice");
        // Delegate to session via setMode; timer handled by VoiceSession
      },
      pattern: "pause voice [{n:number} minutes]",
    }),

    command({
      name: "stop-everything",
      phrase: "stop everything",
      description: "Stop gaze-follow, continuous scroll, pending chains, running automations",
      run: (ctx) => {
        ctx.gazeFollow?.stop();
        ctx.log("[voice] stopped everything");
      },
      modes: ["command", "agent"],
    }),
  ],
});

export default META_PACK;
