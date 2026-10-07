/**
 * The ONE list of shipped voice commands.
 *
 * Order = match priority on ties (built-ins first, as before). Used by the
 * module's `extensions` AND by the `parse` subcommand, so the two can never
 * drift apart.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { BUILTIN_PACK } from "../voiceCommands";
import type { AnyVoicePack } from "./define";
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
export function allPacks(): AnyVoicePack[] {
  return [
    BUILTIN_PACK,
    META_PACK,
    GAZE_MOUSE_PACK,
    TEXT_PACK,
    KEYS_PACK,
    WINDOWS_PACK,
    SYSTEM_PACK,
    HINTS_PACK,
    TMUX_PACK,
    BROWSER_PACK,
    SMART_TYPE_PACK,
  ];
}

/** Flat list of every shipped voice command extension. */
export function voiceCommandExtensions(): VoiceCommandExtension[] {
  return allPacks().flatMap((p) => p.extensions);
}
