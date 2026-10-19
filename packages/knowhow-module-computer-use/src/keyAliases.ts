/**
 * Key-name normalization shared by the service, SDK, and macro runner.
 *
 *  - `mod` → `command` on macOS, `control` elsewhere (the "copy/paste" modifier).
 *  - `lalt/ralt/lctrl/rctrl/lshift/rshift/lwin/rwin` map to the base modifier for
 *    now (the native core does not distinguish left/right yet).
 *  - F1–F24 parse natively and pass through unchanged.
 */

const SIDED_MODIFIERS: Record<string, string> = {
  lalt: "alt",
  ralt: "alt",
  loption: "alt",
  roption: "alt",
  lctrl: "control",
  rctrl: "control",
  lcontrol: "control",
  rcontrol: "control",
  lshift: "shift",
  rshift: "shift",
  lwin: "command",
  rwin: "command",
  lcmd: "command",
  rcmd: "command",
  lcommand: "command",
  rcommand: "command",
  lmeta: "command",
  rmeta: "command",
};

export function modKey(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "command" : "control";
}

/** Normalize a single key name. Unknown names are returned untouched. */
export function normalizeKeyName(
  key: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (typeof key !== "string") return key;
  const lower = key.trim().toLowerCase();
  if (lower === "mod") return modKey(platform);
  if (lower in SIDED_MODIFIERS) {
    const base = SIDED_MODIFIERS[lower];
    // `lwin` on non-mac platforms is the Windows/Super key, which the native
    // core spells `meta`/`super`; `command` is its mac spelling.
    if (base === "command" && platform !== "darwin" && /win|meta/.test(lower)) {
      return "meta";
    }
    return base;
  }
  return key;
}

export function normalizeKeyNames(
  keys: string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  return keys.map((k) => normalizeKeyName(k, platform));
}
