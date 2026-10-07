/**
 * Keys & editing pack: keyboard shortcuts, navigation, editing.
 * Covers commands.md §4.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { VOICE_COMMAND_EXTENSION } from "../voiceCommands";

function cmd(
  name: string,
  phrase: string,
  description: string,
  run: VoiceCommandExtension["run"],
  extras: Partial<VoiceCommandExtension> = {},
): VoiceCommandExtension {
  return {
    type: VOICE_COMMAND_EXTENSION,
    name: `voice-control.keys.${name}`,
    phrase,
    description,
    run,
    modes: ["command"],
    ...extras,
  };
}

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
    once: 1, twice: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
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

export const KEYS_PACK: VoiceCommandExtension[] = [
  // ─── Common editing ──────────────────────────────────────────────────────
  cmd("select-all", "select all", "Select all (Cmd-A)", async (ctx) => {
    const { app } = extractInApp(ctx.text);
    await press(ctx, "mod+a", { app });
  }, { aliases: ["select all"], minVoicedMs: 200 } as any),

  cmd("copy", "copy", "Copy (Cmd-C)", async (ctx) => {
    await press(ctx, "mod+c");
  }, { minVoicedMs: 200 } as any),

  cmd("cut", "cut", "Cut (Cmd-X)", async (ctx) => {
    await press(ctx, "mod+x");
  }),

  cmd("paste", "paste", "Paste (Cmd-V)", async (ctx) => {
    await press(ctx, "mod+v");
  }, { minVoicedMs: 200 } as any),

  cmd("paste-plain", "paste plain", "Paste without formatting (Cmd-Shift-Opt-V)", async (ctx) => {
    await press(ctx, "mod+shift+alt+v");
  }, { aliases: ["paste without formatting"] }),

  cmd("undo", "undo", "Undo (Cmd-Z)", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "mod+z", { repeat: n });
  }, { repeatable: true, pattern: "undo [{n:number}]" } as any),

  cmd("redo", "redo", "Redo (Cmd-Shift-Z)", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "mod+shift+z", { repeat: n });
  }, { repeatable: true, pattern: "redo [{n:number}]" } as any),

  cmd("save", "save", "Save (Cmd-S)", async (ctx) => {
    await press(ctx, "mod+s");
  }, { minVoicedMs: 200 } as any),

  cmd("find", "find", "Open find (Cmd-F) and type search term", async (ctx) => {
    const raw = ctx.text.replace(/^find\s+/i, "");
    const actions = (ctx as any).actions;
    if (actions) {
      const app = await actions.frontmostApp?.();
      await actions.pressCombo("mod+f", { app });
      if (raw) {
        await new Promise((r) => setTimeout(r, 200));
        await actions.typeText(raw, { app });
      }
    }
  }, { pattern: "find {text:text}" } as any),

  // ─── Basic keys ──────────────────────────────────────────────────────────
  cmd("enter", "enter", "Press Enter", async (ctx) => {
    await press(ctx, "enter");
  }, { aliases: ["return", "new line", "newline"], minVoicedMs: 200 } as any),

  cmd("escape", "escape", "Press Escape", async (ctx) => {
    await press(ctx, "escape");
  }, { aliases: ["esc"] }),

  cmd("tab", "tab", "Press Tab", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "tab", { repeat: n });
  }, { repeatable: true, pattern: "tab [{n:number}]" } as any),

  cmd("shift-tab", "shift tab", "Press Shift-Tab (back-tab)", async (ctx) => {
    await press(ctx, "shift+tab");
  }, { aliases: ["back tab"] }),

  cmd("space", "space", "Press Space", async (ctx) => {
    await press(ctx, "space");
  }),

  cmd("backspace", "backspace", "Press Backspace", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "backspace", { repeat: n });
  }, { repeatable: true, pattern: "backspace [{n:number}]" } as any),

  cmd("delete", "delete", "Press Delete (forward delete)", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "delete", { repeat: n });
  }, { repeatable: true, pattern: "delete [{n:number}]" } as any),

  // ─── Arrow keys ──────────────────────────────────────────────────────────
  cmd("up", "up", "Press Up arrow", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "up", { repeat: n });
  }, { repeatable: true, pattern: "up [{n:number}]" } as any),

  cmd("down", "down", "Press Down arrow", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "down", { repeat: n });
  }, { repeatable: true, pattern: "down [{n:number}]" } as any),

  cmd("left", "left", "Press Left arrow", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "left", { repeat: n });
  }, { repeatable: true, pattern: "left [{n:number}]" } as any),

  cmd("right", "right", "Press Right arrow", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "right", { repeat: n });
  }, { repeatable: true, pattern: "right [{n:number}]" } as any),

  // ─── Word/line navigation ─────────────────────────────────────────────────
  cmd("word-left", "word left", "Move one word left (Opt-Left)", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "alt+left", { repeat: n });
  }, { repeatable: true, pattern: "word left [{n:number}]" } as any),

  cmd("word-right", "word right", "Move one word right (Opt-Right)", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "alt+right", { repeat: n });
  }, { repeatable: true, pattern: "word right [{n:number}]" } as any),

  cmd("line-start", "line start", "Go to line start (Cmd-Left)", async (ctx) => {
    await press(ctx, "mod+left");
  }, { aliases: ["beginning of line", "start of line"] }),

  cmd("line-end", "line end", "Go to line end (Cmd-Right)", async (ctx) => {
    await press(ctx, "mod+right");
  }, { aliases: ["end of line"] }),

  cmd("go-top", "go top", "Go to top of document (Cmd-Up)", async (ctx) => {
    await press(ctx, "mod+up");
  }, { aliases: ["top of document", "beginning of document"] }),

  cmd("go-bottom", "go bottom", "Go to bottom of document (Cmd-Down)", async (ctx) => {
    await press(ctx, "mod+down");
  }, { aliases: ["bottom of document", "end of document"] }),

  // ─── Selection ────────────────────────────────────────────────────────────
  cmd("select-word", "select word", "Select word (Opt-Shift-Right)", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "alt+shift+right", { repeat: n });
  }, { repeatable: true }),

  cmd("select-line", "select line", "Select line (Cmd-Shift-Right)", async (ctx) => {
    await press(ctx, "mod+shift+right");
  }),

  cmd("select-left", "select left", "Extend selection left", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "shift+left", { repeat: n });
  }, { repeatable: true, pattern: "select left [{n:number}]" } as any),

  cmd("select-right", "select right", "Extend selection right", async (ctx) => {
    const n = repeatFromText(ctx.text);
    await press(ctx, "shift+right", { repeat: n });
  }, { repeatable: true, pattern: "select right [{n:number}]" } as any),

  // ─── Delete ───────────────────────────────────────────────────────────────
  cmd("delete-word", "delete word", "Delete word (Opt-Backspace)", async (ctx) => {
    await press(ctx, "alt+backspace");
  }, { aliases: ["delete previous word"] }),

  cmd("delete-line", "delete line", "Delete line (Cmd-Backspace)", async (ctx) => {
    await press(ctx, "mod+backspace");
  }),

  // ─── Generic press combo ──────────────────────────────────────────────────
  cmd(
    "press",
    "press",
    "Press a key combination",
    async (ctx) => {
      const raw = ctx.text.replace(/^press\s+/i, "");
      const { base, app } = extractInApp(raw);
      // Parse combo: "command shift p" → "mod+shift+p"
      const tokens = base.toLowerCase().split(/\s+/);
      const MOD_MAP: Record<string, string> = {
        command: "mod", cmd: "mod", control: "ctrl", ctrl: "ctrl",
        option: "alt", alt: "alt", shift: "shift",
      };
      const mods: string[] = [];
      let keyIdx = tokens.length - 1;
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i] in MOD_MAP) mods.push(MOD_MAP[tokens[i]]);
        else { keyIdx = i; break; }
      }
      const key = tokens[keyIdx];
      if (!key) return;
      const combo = [...mods, key].join("+");
      await press(ctx, combo, { app });
    },
    { pattern: "press {key:key} [in {app:app}]" } as any,
  ),
];

export default KEYS_PACK;
