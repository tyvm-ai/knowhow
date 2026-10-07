/**
 * Text & dictation pack: type, send, dictate, spell, camel/snake/kebab, correct, scratch that.
 * Covers commands.md §3.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { VOICE_COMMAND_EXTENSION } from "../voiceCommands";
import { convertDictation, applyCase, expandSpell } from "../grammar/dictation";

function cmd(
  name: string,
  phrase: string,
  description: string,
  run: VoiceCommandExtension["run"],
  extras: Partial<VoiceCommandExtension> = {},
): VoiceCommandExtension {
  return {
    type: VOICE_COMMAND_EXTENSION,
    name: `voice-control.text.${name}`,
    phrase,
    description,
    run,
    modes: ["command"],
    ...extras,
  };
}

/** Last typed text chunk for "scratch that" / "correct X to Y". */
let lastTyped: string | undefined;

/** Whether dictation mode is active. */
let dictationMode = false;

/** Extract the dictation text after a verb prefix. */
function extractAfter(text: string, verbs: string[]): string {
  const lower = text.toLowerCase();
  for (const verb of verbs) {
    const idx = lower.indexOf(verb);
    if (idx !== -1) {
      return text.slice(idx + verb.length).trim();
    }
  }
  return text;
}

/** Normalise text for typing: strip Whisper's trailing period and surrounding quotes. */
function normaliseForTyping(text: string): string {
  // Remove surrounding double/curly quotes
  text = text.replace(/^[""\u201C](.+?)[""\u201D]$/, "$1");
  // Remove trailing period Whisper adds
  text = text.replace(/\.$/, "");
  return text.trim();
}

export const TEXT_PACK: VoiceCommandExtension[] = [
  // ─── Type ────────────────────────────────────────────────────────────────
  cmd(
    "type",
    "type",
    "Type spoken text at the focused app",
    async (ctx) => {
      const actions = (ctx as any).actions;
      const app = await actions?.frontmostApp?.();
      const raw = extractAfter(ctx.text, ["type "]);
      const text = convertDictation(normaliseForTyping(raw));
      if (!text) return;
      lastTyped = text;
      if (actions) {
        await actions.typeText(text, { app });
      } else {
        ctx.log(`[voice] type: "${text}"`);
      }
    },
    { pattern: "type {text:text}" } as any,
  ),

  // ─── Send ────────────────────────────────────────────────────────────────
  cmd(
    "send",
    "send",
    "Type spoken text then press Enter",
    async (ctx) => {
      const actions = (ctx as any).actions;
      const app = await actions?.frontmostApp?.();
      const raw = extractAfter(ctx.text, ["send "]);
      const text = convertDictation(normaliseForTyping(raw));
      if (!text) return;
      lastTyped = text + "\n";
      if (actions) {
        await actions.typeText(text, { app });
        await actions.pressCombo("enter", { app });
      } else {
        ctx.log(`[voice] send: "${text}"`);
      }
    },
    { pattern: "send {text:text}" } as any,
  ),

  // ─── Dictate / stop dictating ─────────────────────────────────────────────
  cmd(
    "dictate",
    "dictate",
    "Enter dictation mode — every utterance is typed",
    (ctx) => {
      dictationMode = true;
      ctx.log("[voice] dictation mode ON");
    },
    { aliases: ["start dictating"] },
  ),

  cmd(
    "stop-dictating",
    "stop dictating",
    "Exit dictation mode",
    (ctx) => {
      dictationMode = false;
      ctx.log("[voice] dictation mode OFF");
    },
    { aliases: ["end dictation", "stop dictation"] },
  ),

  // ─── Spell ───────────────────────────────────────────────────────────────
  cmd(
    "spell",
    "spell",
    "Spell individual letters or NATO phonetic alphabet",
    async (ctx) => {
      const raw = extractAfter(ctx.text, ["spell "]);
      const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
      const spelled = expandSpell(raw);
      const actions = (ctx as any).actions;
      const app = await actions?.frontmostApp?.();
      lastTyped = spelled;
      if (actions) {
        await actions.typeText(spelled, { app });
      } else {
        ctx.log(`[voice] spell: "${spelled}"`);
      }
    },
    { pattern: "spell {text:text}" } as any,
  ),

  // ─── Casing commands ─────────────────────────────────────────────────────
  ...["camel", "snake", "kebab", "title", "caps"].map((style) =>
    cmd(
      style,
      style,
      `Type text in ${style} case`,
      async (ctx) => {
        const raw = extractAfter(ctx.text, [`${style} `]);
        const text = applyCase(style, normaliseForTyping(raw));
        const actions = (ctx as any).actions;
        const app = await actions?.frontmostApp?.();
        lastTyped = text;
        if (actions) {
          await actions.typeText(text, { app });
        } else {
          ctx.log(`[voice] ${style}: "${text}"`);
        }
      },
      { pattern: `${style} {text:text}` } as any,
    ),
  ),

  // ─── Correct X to Y ──────────────────────────────────────────────────────
  cmd(
    "correct",
    "correct",
    "Replace the last typed occurrence of a word",
    async (ctx) => {
      const text = ctx.text;
      const match = text.match(/correct\s+(.+?)\s+to\s+(.+)/i);
      if (!match) return;
      const [, wrong, right] = match;
      ctx.log(`[voice] correct "${wrong}" to "${right}"`);
      const actions = (ctx as any).actions;
      const app = await actions?.frontmostApp?.();
      // Select all → find and replace is complex; simpler: Cmd+Z until text changes, then retype
      // For now: Cmd+H (find and replace) approach
      if (actions) {
        await actions.pressCombo("mod+h", { app });
        await new Promise((r) => setTimeout(r, 300));
        await actions.typeText(wrong, { app });
        await actions.pressCombo("tab", { app });
        await actions.typeText(right, { app });
        await actions.pressCombo("enter", { app });
        await actions.pressCombo("escape", { app });
      }
    },
    { pattern: "correct {wrong:text} to {right:text}" } as any,
  ),

  // ─── Scratch that ─────────────────────────────────────────────────────────
  cmd(
    "scratch-that",
    "scratch that",
    "Delete the last chunk typed by voice",
    async (ctx) => {
      if (!lastTyped) {
        ctx.log("[voice] scratch that: nothing to scratch");
        return;
      }
      const actions = (ctx as any).actions;
      const app = await actions?.frontmostApp?.();
      const n = lastTyped.length;
      ctx.log(`[voice] scratch that: deleting ${n} chars`);
      if (actions) {
        for (let i = 0; i < n; i++) {
          await actions.pressCombo("backspace", { app });
        }
      }
      lastTyped = undefined;
    },
  ),
];

export default TEXT_PACK;

/** Export dictation mode state for external use. */
export function isDictationMode(): boolean {
  return dictationMode;
}

/** Set the last typed text (for smarttype to integrate with "scratch that"). */
export function setLastTypedExternal(text: string): void {
  lastTyped = text;
}
