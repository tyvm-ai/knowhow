/**
 * Meta pack: modes, what-can-I-say, cancel, repeat, confirm, undo, pause.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { VOICE_COMMAND_EXTENSION } from "../voiceCommands";
import { takePending } from "../pendingAction";

function cmd(
  name: string,
  phrase: string,
  description: string,
  run: VoiceCommandExtension["run"],
  extras: Partial<VoiceCommandExtension> = {},
): VoiceCommandExtension {
  return {
    type: VOICE_COMMAND_EXTENSION,
    name: `voice-control.meta.${name}`,
    phrase,
    description,
    run,
    modes: ["command"],
    ...extras,
  };
}

export const META_PACK: VoiceCommandExtension[] = [
  cmd(
    "what-can-i-say",
    "what can I say",
    "Show overlay of available commands",
    (ctx) => {
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
    { aliases: ["show commands", "help", "what commands", "list commands", "what commands do we have", "what commands do i have", "commands"], modes: ["command", "agent"] },
  ),

  cmd(
    "hide-commands",
    "hide commands",
    "Hide the commands overlay",
    (ctx) => { ctx.log("[voice] hide commands overlay"); },
    { modes: ["command", "agent"] },
  ),

  cmd(
    "cancel",
    "cancel",
    "Cancel pending action or chain",
    async (ctx) => {
      const pending = takePending();
      if (pending) {
        ctx.log(`[voice] cancel: ${pending.describe}`);
        await pending.reject();
      } else {
        ctx.log("[voice] cancel");
      }
    },
    { aliases: ["never mind", "nevermind", "abort", "no", "reject"] },
  ),

  cmd(
    "confirm",
    "confirm",
    "Confirm a pending risky action",
    async (ctx) => {
      const pending = takePending();
      if (pending) {
        ctx.log(`[voice] confirm: ${pending.describe}`);
        await pending.accept();
      } else {
        ctx.log("[voice] confirm pending action");
      }
    },
    { aliases: ["type it", "yes", "do it"] },
  ),

  cmd(
    "repeat",
    "repeat",
    "Repeat the last command",
    (ctx) => { ctx.log("[voice] repeat last command"); },
    { aliases: ["again", "do it again"], repeatable: false } as any,
  ),

  cmd(
    "redo",
    "redo",
    "Redo / regenerate the last pending action",
    async (ctx) => {
      const pending = takePending();
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
    { aliases: ["try again"] },
  ),

  cmd(
    "undo-that",
    "undo that",
    "Undo the last reversible voice action",
    async (ctx) => {
      const history = ctx.history as Array<{
        type: string;
        win?: { app: string; bounds: { x: number; y: number; width: number; height: number } };
        bounds?: { x: number; y: number; width: number; height: number };
      }> | undefined;
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
    { aliases: ["revert that"] },
  ),

  cmd(
    "pause-voice",
    "pause voice",
    "Pause voice command mode temporarily",
    (ctx) => {
      ctx.log("[voice] pausing voice");
      // Delegate to session via setMode; timer handled by VoiceSession
    },
    { pattern: "pause voice [{n:number} minutes]" } as any,
  ),

  cmd(
    "stop-everything",
    "stop everything",
    "Stop gaze-follow, continuous scroll, pending chains, running automations",
    (ctx) => {
      ctx.gazeFollow?.stop();
      ctx.log("[voice] stopped everything");
    },
    { modes: ["command", "agent"] },
  ),
];

export default META_PACK;
