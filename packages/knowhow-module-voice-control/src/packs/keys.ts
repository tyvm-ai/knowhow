/**
 * Keys & editing pack: keyboard shortcuts, navigation, editing.
 * Covers commands.md §4.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { defineVoicePack } from "./define";

/** Helper to press a combo with optional app focus. */
async function press(ctx: any, combo: string, opts?: { app?: string; repeat?: number }): Promise<void> {
  const actions = ctx.actions;
  if (actions) {
    await actions.pressCombo(combo, opts);
  } else {
    ctx.log(`[voice] press: ${combo}`);
  }
}

/** Extract repeat count from context text e.g. "down 5" → 5. */
function repeatFromText(text: string): number {
  const m = text.match(/(\d+)(?:\s+times?)?$/);
  if (m) return parseInt(m[1], 10);
  const WORDS: Record<string, number> = {
    once: 1,
    twice: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  for (const [w, n] of Object.entries(WORDS)) {
    if (text.includes(w)) return n;
  }
  return 1;
}

/** Extract app name from "... in <app>" pattern. */
function extractInApp(text: string): { base: string; app?: string } {
  const m = text.match(/^(.*?)\s+in\s+(\w[\w\s]*)$/i);
  if (m) return { base: m[1].trim(), app: m[2].trim() };
  return { base: text, app: undefined };
}

export const KEYS_PACK = defineVoicePack({
  name: "keys",
  description: "Keyboard shortcuts, navigation and editing",
  prefix: "voice-control.keys.",
  commands: ({ command }) => [
    // ─── Common editing ──────────────────────────────────────────────────────
    command({
      name: "select-all",
      phrase: "select all",
      description: "Select all (Cmd-A)",
      run: async (ctx) => {
        const { app } = extractInApp(ctx.text);
        await press(ctx, "mod+a", { app });
      },
      aliases: ["select all"],
      minVoicedMs: 200,
    }),

    command({
      name: "copy",
      phrase: "copy",
      description: "Copy (Cmd-C)",
      run: async (ctx) => {
        await press(ctx, "mod+c");
      },
      minVoicedMs: 200,
    }),

    command({
      name: "cut",
      phrase: "cut",
      description: "Cut (Cmd-X)",
      run: async (ctx) => {
        await press(ctx, "mod+x");
      },
    }),

    command({
      name: "paste",
      phrase: "paste",
      description: "Paste (Cmd-V)",
      run: async (ctx) => {
        await press(ctx, "mod+v");
      },
      minVoicedMs: 200,
    }),

    command({
      name: "paste-plain",
      phrase: "paste plain",
      description: "Paste without formatting (Cmd-Shift-Opt-V)",
      run: async (ctx) => {
        await press(ctx, "mod+shift+alt+v");
      },
      aliases: ["paste without formatting"],
    }),

    command({
      name: "undo",
      phrase: "undo",
      description: "Undo (Cmd-Z)",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "mod+z", { repeat: n });
      },
      repeatable: true,
      pattern: "undo [{n:number}]",
    }),

    command({
      name: "save",
      phrase: "save",
      description: "Save (Cmd-S)",
      run: async (ctx) => {
        await press(ctx, "mod+s");
      },
      minVoicedMs: 200,
    }),

    command({
      name: "find",
      phrase: "find",
      description: "Open find (Cmd-F) and type search term",
      run: async (ctx) => {
        const raw = ctx.text.replace(/^find\s+/i, "");
        const actions = (ctx as any).actions;
        if (actions) {
          const app = await actions.frontmostApp?.();
          await actions.pressCombo("mod+f", { app });
          if (raw) {
            await ctx.services.clock.sleep(200);
            await actions.typeText(raw, { app });
          }
        }
      },
      pattern: "find {text:text}",
    }),

    // ─── Basic keys ──────────────────────────────────────────────────────────
    command({
      name: "enter",
      phrase: "enter",
      description: "Press Enter",
      run: async (ctx) => {
        await press(ctx, "enter");
      },
      aliases: ["return", "new line", "newline"],
      minVoicedMs: 200,
    }),

    command({
      name: "escape",
      phrase: "escape",
      description: "Press Escape",
      run: async (ctx) => {
        await press(ctx, "escape");
      },
      aliases: ["esc"],
    }),

    command({
      name: "tab",
      phrase: "tab",
      description: "Press Tab",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "tab", { repeat: n });
      },
      repeatable: true,
      pattern: "tab [{n:number}]",
    }),

    command({
      name: "shift-tab",
      phrase: "shift tab",
      description: "Press Shift-Tab (back-tab)",
      run: async (ctx) => {
        await press(ctx, "shift+tab");
      },
      aliases: ["back tab"],
    }),

    command({
      name: "space",
      phrase: "space",
      description: "Press Space",
      run: async (ctx) => {
        await press(ctx, "space");
      },
    }),

    command({
      name: "backspace",
      phrase: "backspace",
      description: "Press Backspace",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "backspace", { repeat: n });
      },
      repeatable: true,
      pattern: "backspace [{n:number}]",
    }),

    command({
      name: "delete",
      phrase: "delete",
      description: "Press Delete (forward delete)",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "delete", { repeat: n });
      },
      repeatable: true,
      pattern: "delete [{n:number}]",
    }),

    // ─── Arrow keys ──────────────────────────────────────────────────────────
    command({
      name: "up",
      phrase: "up",
      description: "Press Up arrow",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "up", { repeat: n });
      },
      repeatable: true,
      pattern: "up [{n:number}]",
    }),

    command({
      name: "down",
      phrase: "down",
      description: "Press Down arrow",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "down", { repeat: n });
      },
      repeatable: true,
      pattern: "down [{n:number}]",
    }),

    command({
      name: "left",
      phrase: "left",
      description: "Press Left arrow",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "left", { repeat: n });
      },
      repeatable: true,
      pattern: "left [{n:number}]",
    }),

    command({
      name: "right",
      phrase: "right",
      description: "Press Right arrow",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "right", { repeat: n });
      },
      repeatable: true,
      pattern: "right [{n:number}]",
    }),

    // ─── Word/line navigation ─────────────────────────────────────────────────
    command({
      name: "word-left",
      phrase: "word left",
      description: "Move one word left (Opt-Left)",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "alt+left", { repeat: n });
      },
      repeatable: true,
      pattern: "word left [{n:number}]",
    }),

    command({
      name: "word-right",
      phrase: "word right",
      description: "Move one word right (Opt-Right)",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "alt+right", { repeat: n });
      },
      repeatable: true,
      pattern: "word right [{n:number}]",
    }),

    command({
      name: "line-start",
      phrase: "line start",
      description: "Go to line start (Cmd-Left)",
      run: async (ctx) => {
        await press(ctx, "mod+left");
      },
      aliases: ["beginning of line", "start of line"],
    }),

    command({
      name: "line-end",
      phrase: "line end",
      description: "Go to line end (Cmd-Right)",
      run: async (ctx) => {
        await press(ctx, "mod+right");
      },
      aliases: ["end of line"],
    }),

    command({
      name: "go-top",
      phrase: "go top",
      description: "Go to top of document (Cmd-Up)",
      run: async (ctx) => {
        await press(ctx, "mod+up");
      },
      aliases: ["top of document", "beginning of document"],
    }),

    command({
      name: "go-bottom",
      phrase: "go bottom",
      description: "Go to bottom of document (Cmd-Down)",
      run: async (ctx) => {
        await press(ctx, "mod+down");
      },
      aliases: ["bottom of document", "end of document"],
    }),

    // ─── Selection ────────────────────────────────────────────────────────────
    command({
      name: "select-word",
      phrase: "select word",
      description: "Select word (Opt-Shift-Right)",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "alt+shift+right", { repeat: n });
      },
      repeatable: true,
    }),

    command({
      name: "select-line",
      phrase: "select line",
      description: "Select line (Cmd-Shift-Right)",
      run: async (ctx) => {
        await press(ctx, "mod+shift+right");
      },
    }),

    command({
      name: "select-left",
      phrase: "select left",
      description: "Extend selection left",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "shift+left", { repeat: n });
      },
      repeatable: true,
      pattern: "select left [{n:number}]",
    }),

    command({
      name: "select-right",
      phrase: "select right",
      description: "Extend selection right",
      run: async (ctx) => {
        const n = repeatFromText(ctx.text);
        await press(ctx, "shift+right", { repeat: n });
      },
      repeatable: true,
      pattern: "select right [{n:number}]",
    }),

    // ─── Delete ───────────────────────────────────────────────────────────────
    command({
      name: "delete-word",
      phrase: "delete word",
      description: "Delete word (Opt-Backspace)",
      run: async (ctx) => {
        await press(ctx, "alt+backspace");
      },
      aliases: ["delete previous word"],
    }),

    command({
      name: "delete-line",
      phrase: "delete line",
      description: "Delete line (Cmd-Backspace)",
      run: async (ctx) => {
        await press(ctx, "mod+backspace");
      },
    }),

    // ─── Generic press combo ──────────────────────────────────────────────────
    command({
      name: "press",
      phrase: "press",
      description: "Press a key combination",
      run: async (ctx) => {
        const raw = ctx.text.replace(/^press\s+/i, "");
        const { base, app } = extractInApp(raw);
        // Parse combo: "command shift p" → "mod+shift+p"
        const tokens = base.toLowerCase().split(/\s+/);
        const MOD_MAP: Record<string, string> = {
          command: "mod",
          cmd: "mod",
          control: "ctrl",
          ctrl: "ctrl",
          option: "alt",
          alt: "alt",
          shift: "shift",
        };
        const mods: string[] = [];
        let keyIdx = tokens.length - 1;
        for (let i = 0; i < tokens.length - 1; i++) {
          if (tokens[i] in MOD_MAP) mods.push(MOD_MAP[tokens[i]]);
          else {
            keyIdx = i;
            break;
          }
        }
        const key = tokens[keyIdx];
        if (!key) return;
        const combo = [...mods, key].join("+");
        await press(ctx, combo, { app });
      },
      pattern: "press {key:key} [in {app:app}]",
    }),
  ],
});

export default KEYS_PACK;
