/**
 * Text & dictation pack: type, send, dictate, spell, camel/snake/kebab, correct, scratch that.
 * Covers commands.md §3.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { convertDictation, applyCase, expandSpell } from "../grammar/dictation";
import { defineVoicePack } from "./define";

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

// "scratch that" / dictation state lives in `services.typing` (shared with the smarttype pack).
export const TEXT_PACK = defineVoicePack({
  name: "text",
  description: "type, send, dictate, spell, camel/snake/kebab, correct, scratch that",
  prefix: "voice-control.text.",
  onSessionStop: ({ services }) => {
    services.typing.dictation = false;
  },
  commands: ({ command }) => [
    // ─── Type ────────────────────────────────────────────────────────────────
    command({
      name: "type",
      phrase: "type",
      description: "Type spoken text at the focused app",
      run: async (ctx) => {
        const actions = (ctx as any).actions;
        const app = await actions?.frontmostApp?.();
        const raw = extractAfter(ctx.text, ["type "]);
        const text = convertDictation(normaliseForTyping(raw));
        if (!text) return;
        ctx.services.typing.lastTyped = text;
        if (actions) {
          await actions.typeText(text, { app });
        } else {
          ctx.log(`[voice] type: "${text}"`);
        }
      },
      pattern: "type {text:text}",
    }),

    // ─── Send ────────────────────────────────────────────────────────────────
    command({
      name: "send",
      phrase: "send",
      description: "Type spoken text then press Enter",
      run: async (ctx) => {
        const actions = (ctx as any).actions;
        const app = await actions?.frontmostApp?.();
        const raw = extractAfter(ctx.text, ["send "]);
        const text = convertDictation(normaliseForTyping(raw));
        if (!text) return;
        ctx.services.typing.lastTyped = text + "\n";
        if (actions) {
          await actions.typeText(text, { app });
          await actions.pressCombo("enter", { app });
        } else {
          ctx.log(`[voice] send: "${text}"`);
        }
      },
      pattern: "send {text:text}",
    }),

    // ─── Dictate / stop dictating ─────────────────────────────────────────────
    command({
      name: "dictate",
      phrase: "dictate",
      description: "Enter dictation mode — every utterance is typed",
      run: (ctx) => {
        ctx.services.typing.dictation = true;
        ctx.log("[voice] dictation mode ON");
      },
      aliases: ["start dictating"],
    }),

    command({
      name: "stop-dictating",
      phrase: "stop dictating",
      description: "Exit dictation mode",
      run: (ctx) => {
        ctx.services.typing.dictation = false;
        ctx.log("[voice] dictation mode OFF");
      },
      aliases: ["end dictation", "stop dictation"],
    }),

    // ─── Spell ───────────────────────────────────────────────────────────────
    command({
      name: "spell",
      phrase: "spell",
      description: "Spell individual letters or NATO phonetic alphabet",
      run: async (ctx) => {
        const raw = extractAfter(ctx.text, ["spell "]);
        const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
        const spelled = expandSpell(raw);
        const actions = (ctx as any).actions;
        const app = await actions?.frontmostApp?.();
        ctx.services.typing.lastTyped = spelled;
        if (actions) {
          await actions.typeText(spelled, { app });
        } else {
          ctx.log(`[voice] spell: "${spelled}"`);
        }
      },
      pattern: "spell {text:text}",
    }),

    // ─── Casing commands ─────────────────────────────────────────────────────
    ...["camel", "snake", "kebab", "title", "caps"].map((style) =>
      command({
        name: style,
        phrase: style,
        description: `Type text in ${style} case`,
        run: async (ctx) => {
          const raw = extractAfter(ctx.text, [`${style} `]);
          const text = applyCase(style, normaliseForTyping(raw));
          const actions = (ctx as any).actions;
          const app = await actions?.frontmostApp?.();
          ctx.services.typing.lastTyped = text;
          if (actions) {
            await actions.typeText(text, { app });
          } else {
            ctx.log(`[voice] ${style}: "${text}"`);
          }
        },
        pattern: `${style} {text:text}`,
      })
    ),

    // ─── Correct X to Y ──────────────────────────────────────────────────────
    command({
      name: "correct",
      phrase: "correct",
      description: "Replace the last typed occurrence of a word",
      run: async (ctx) => {
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
      pattern: "correct {wrong:text} to {right:text}",
    }),

    // ─── Scratch that ─────────────────────────────────────────────────────────
    command({
      name: "scratch-that",
      phrase: "scratch that",
      description: "Delete the last chunk typed by voice",
      run: async (ctx) => {
        const lastTyped = ctx.services.typing.lastTyped;
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
        ctx.services.typing.lastTyped = undefined;
      },
    }),
  ],
});

export default TEXT_PACK;
