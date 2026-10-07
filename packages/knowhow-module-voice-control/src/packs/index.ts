/**
 * The ONE list of shipped voice commands.
 *
 * Order = match priority on ties (built-ins first, as before). Used by the
 * module's `extensions` AND by the `parse` subcommand, so the two can never
 * drift apart.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { BUILTIN_VOICE_COMMANDS } from "../voiceCommands";
import META_PACK from "./meta";
import GAZE_MOUSE_PACK from "./gazeMouse";
import TEXT_PACK from "./text";
import KEYS_PACK from "./keys";
import { WINDOWS_PACK } from "./windows";
import { SYSTEM_PACK } from "./system";
import { HINTS_PACK } from "./hints";
import { TMUX_PACK } from "./tmux";
import { BROWSER_PACK } from "./browser";
import { SMART_TYPE_PACK } from "./smartType";

/** Every command pack, in priority order. */
export function allPacks(): ReadonlyArray<{ name: string; commands: VoiceCommandExtension[] }> {
  return [
    { name: "built-in", commands: BUILTIN_VOICE_COMMANDS },
    { name: "meta", commands: META_PACK },
    { name: "gaze-mouse", commands: GAZE_MOUSE_PACK },
    { name: "text", commands: TEXT_PACK },
    { name: "keys", commands: KEYS_PACK },
    { name: "windows", commands: WINDOWS_PACK },
    { name: "system", commands: SYSTEM_PACK },
    { name: "hints", commands: HINTS_PACK },
    { name: "tmux", commands: TMUX_PACK },
    { name: "browser", commands: BROWSER_PACK },
    { name: "smart-type", commands: SMART_TYPE_PACK },
  ];
}

/** Flat list of every shipped voice command extension. */
export function voiceCommandExtensions(): VoiceCommandExtension[] {
  return allPacks().flatMap((p) => p.commands);
}
