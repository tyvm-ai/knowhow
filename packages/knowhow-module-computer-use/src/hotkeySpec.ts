import * as fs from "fs";
import { homeDir } from "./homeDir";
import * as path from "path";

/**
 * Hotkey spec parser + kill-switch config.
 *
 * Specs look like `"F6"`, `"ctrl+shift+k"`, `"mod+c"`, `"ctrl+alt+esc"` and
 * normalize to `{ key, mods: { ctrl, alt, shift, meta } }`.
 */

export interface HotkeyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedHotkey {
  /** Normalized key name: single lowercase char, `f1`..`f24`, or a named key. */
  key: string;
  mods: HotkeyMods;
}

/** Default global kill switch chord (plan §6.3). */
export const KILL_SWITCH_DEFAULT = "ctrl+alt+esc";

const MOD_ALIASES: Record<string, keyof HotkeyMods | "mod"> = {
  ctrl: "ctrl",
  control: "ctrl",
  lctrl: "ctrl",
  rctrl: "ctrl",
  lcontrol: "ctrl",
  rcontrol: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  lalt: "alt",
  ralt: "alt",
  shift: "shift",
  lshift: "shift",
  rshift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  windows: "meta",
  super: "meta",
  lwin: "meta",
  rwin: "meta",
  mod: "mod",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  del: "delete",
  delete: "delete",
  ins: "insert",
  insert: "insert",
  bksp: "backspace",
  backspace: "backspace",
  spacebar: "space",
  space: "space",
  tab: "tab",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  home: "home",
  end: "end",
  pgup: "pageup",
  pageup: "pageup",
  pgdn: "pagedown",
  pagedown: "pagedown",
  capslock: "capslock",
  plus: "+",
  minus: "-",
  comma: ",",
  period: ".",
};

function normalizeMainKey(raw: string, spec: string): string {
  const lower = raw.toLowerCase();
  if (lower in KEY_ALIASES) return KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower;
  if (/^numpad[0-9]$/.test(lower)) return lower;
  // Single printable character (letters, digits, punctuation).
  if ([...raw].length === 1) return lower;
  throw new Error(`Invalid hotkey spec "${spec}": unknown key "${raw}"`);
}

/**
 * Parse a hotkey spec. Throws a descriptive Error for empty/invalid specs.
 * `mod` becomes `meta` on darwin and `ctrl` elsewhere.
 */
export function parseHotkeySpec(
  spec: string,
  platform: NodeJS.Platform = process.platform
): ParsedHotkey {
  if (typeof spec !== "string" || !spec.trim()) {
    throw new Error("Invalid hotkey spec: expected a non-empty string like \"F6\" or \"ctrl+shift+k\"");
  }
  // Split on "+", but allow a literal "+" as the final key ("ctrl++").
  const trimmed = spec.trim();
  let parts: string[];
  if (trimmed.endsWith("++")) {
    parts = trimmed.slice(0, -2).split("+").filter(Boolean).concat("+");
  } else if (trimmed === "+") {
    parts = ["+"];
  } else {
    parts = trimmed.split("+").map((p) => p.trim());
  }
  if (parts.some((p) => !p)) {
    throw new Error(`Invalid hotkey spec "${spec}": empty segment`);
  }
  const mods: HotkeyMods = { ctrl: false, alt: false, shift: false, meta: false };
  let key: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const modName = MOD_ALIASES[part.toLowerCase()];
    if (modName && !(isLast && parts.length === 1)) {
      if (isLast) {
        throw new Error(`Invalid hotkey spec "${spec}": missing a non-modifier key`);
      }
      if (modName === "mod") {
        if (platform === "darwin") mods.meta = true;
        else mods.ctrl = true;
      } else {
        mods[modName] = true;
      }
      continue;
    }
    if (!isLast) {
      throw new Error(`Invalid hotkey spec "${spec}": "${part}" is not a modifier`);
    }
    key = normalizeMainKey(part, spec);
  }
  if (!key) {
    throw new Error(`Invalid hotkey spec "${spec}": missing a non-modifier key`);
  }
  return { key, mods };
}

/** Canonical string for a parsed hotkey, e.g. `ctrl+alt+escape`. */
export function formatHotkey(h: ParsedHotkey): string {
  const out: string[] = [];
  if (h.mods.ctrl) out.push("ctrl");
  if (h.mods.alt) out.push("alt");
  if (h.mods.shift) out.push("shift");
  if (h.mods.meta) out.push("meta");
  out.push(h.key);
  return out.join("+");
}

export function hotkeysEqual(a: ParsedHotkey, b: ParsedHotkey): boolean {
  return (
    a.key === b.key &&
    a.mods.ctrl === b.mods.ctrl &&
    a.mods.alt === b.mods.alt &&
    a.mods.shift === b.mods.shift &&
    a.mods.meta === b.mods.meta
  );
}

/** Path of the user config that carries `killSwitch`. */
export function computerConfigPath(): string {
  return path.join(homeDir(), ".knowhow", "computer.json");
}

/**
 * The configured kill-switch chord: `~/.knowhow/computer.json` → `killSwitch`,
 * else {@link KILL_SWITCH_DEFAULT}. Invalid/missing config falls back to default.
 */
export function getKillSwitch(): string {
  try {
    const raw = fs.readFileSync(computerConfigPath(), "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.killSwitch === "string" && cfg.killSwitch.trim()) {
      // Validate so a typo in the config can't silently disable protection.
      parseHotkeySpec(cfg.killSwitch);
      return cfg.killSwitch.trim();
    }
  } catch {
    /* fall through to the default */
  }
  return KILL_SWITCH_DEFAULT;
}

/** True if `spec` is (equivalent to) the kill-switch chord. */
export function isKillSwitchSpec(
  spec: string | ParsedHotkey,
  platform: NodeJS.Platform = process.platform
): boolean {
  const parsed = typeof spec === "string" ? parseHotkeySpec(spec, platform) : spec;
  const killers = new Set<string>([KILL_SWITCH_DEFAULT, getKillSwitch()]);
  // The default chord stays reserved even if the user remapped the kill switch
  // elsewhere: it's what docs and muscle memory point at.
  return [...killers].some((k) => hotkeysEqual(parsed, parseHotkeySpec(k, platform)));
}
