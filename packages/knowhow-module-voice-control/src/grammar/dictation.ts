/**
 * Dictation helpers.
 *
 * Converts spoken punctuation/formatting tokens into their text equivalents.
 * Used by the `type`, `send`, and `dictate` commands.
 */

/** NATO phonetic alphabet → letter. */
const NATO: Record<string, string> = {
  alpha: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f",
  golf: "g", hotel: "h", india: "i", juliet: "j", kilo: "k", lima: "l",
  mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r",
  sierra: "s", tango: "t", uniform: "u", victor: "v", whiskey: "w",
  xray: "x", "x-ray": "x", yankee: "y", zulu: "z",
};

/** Spoken punctuation tokens → output string. */
const PUNCT_MAP: Array<[string, string]> = [
  // Multi-word first (order matters for replacement)
  ["new paragraph", "\n\n"],
  ["new line", "\n"],
  ["full stop", "."],
  ["question mark", "?"],
  ["exclamation mark", "!"],
  ["exclamation point", "!"],
  ["open quote", '"'],
  ["close quote", '"'],
  ["open paren", "("],
  ["close paren", ")"],
  ["open bracket", "["],
  ["close bracket", "]"],
  ["open brace", "{"],
  ["close brace", "}"],
  ["em dash", "—"],
  ["en dash", "–"],
  ["at sign", "@"],
  ["hash mark", "#"],
  ["number sign", "#"],
  ["percent sign", "%"],
  ["plus sign", "+"],
  ["equals sign", "="],
  ["less than", "<"],
  ["greater than", ">"],
  ["dollar sign", "$"],
  ["caret sign", "^"],
  ["pipe sign", "|"],
  ["back tick", "`"],
  // Single-word
  ["comma", ","],
  ["period", "."],
  ["colon", ":"],
  ["semicolon", ";"],
  ["dash", "-"],
  ["slash", "/"],
  ["backslash", "\\"],
  ["ampersand", "&"],
  ["underscore", "_"],
  ["asterisk", "*"],
  ["tilde", "~"],
  ["backtick", "`"],
  ["newline", "\n"],
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert spoken punctuation tokens in dictation text.
 *
 * Examples:
 *   "hello comma world" → "hello, world"
 *   "hello period" → "hello."
 *   "new line" → "\n"
 */
export function convertDictation(text: string): string {
  // Remove surrounding double/curly quotes
  let result = text.replace(/^[""\u201C](.+?)[""\u201D]$/, "$1").trim();

  // Track if user explicitly said "period" at the end (don't strip trailing period in that case)
  const endsWithSpokenPeriod = /\bperiod\s*$/i.test(result) || /\bfull stop\s*$/i.test(result);

  // Apply punctuation replacements (multi-word first by table order)
  for (const [token, replacement] of PUNCT_MAP) {
    const escaped = escapeRegex(token);
    // Word-boundary style: not preceded/followed by word chars
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "gi");
    result = result.replace(re, replacement);
  }

  // Fix spacing: remove space before punctuation (" ," → ",")
  result = result.replace(/ ([,.\?!:;])/g, "$1");
  // Fix spacing around newlines: "hello \n world" → "hello\nworld"
  result = result.replace(/\s*\n\s*/g, "\n");
  // Collapse multiple spaces
  result = result.replace(/  +/g, " ").trim();

  // Strip Whisper's trailing period ONLY when the user didn't explicitly say "period"
  if (!endsWithSpokenPeriod) {
    result = result.replace(/\.$/, "").trim();
  }

  return result;
}

/**
 * Convert casing commands: camel, snake, kebab, title, caps.
 */
export function applyCase(style: string, text: string): string {
  const words = text.trim().split(/\s+/);
  switch (style) {
    case "camel":
      return words.map((w, i) => i === 0 ? w.toLowerCase() : capitalise(w)).join("");
    case "snake":
      return words.map((w) => w.toLowerCase()).join("_");
    case "kebab":
      return words.map((w) => w.toLowerCase()).join("-");
    case "title":
      return words.map(capitalise).join(" ");
    case "caps":
      return words.map((w) => w.toUpperCase()).join(" ");
    case "pascal":
      return words.map(capitalise).join("");
    default:
      return text;
  }
}

function capitalise(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/**
 * Expand NATO alphabet letters: ["kilo", "november", "oscar", "whiskey"] → "know"
 */
export function expandNato(tokens: string[]): string {
  return tokens.map((t) => NATO[t.toLowerCase()] ?? t).join("");
}

/**
 * Expand a "spell k n o w" utterance: individual letters or NATO words → string.
 */
export function expandSpell(text: string): string {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.map((t) => {
    if (t.length === 1 && /[a-z0-9]/.test(t)) return t;
    if (t in NATO) return NATO[t];
    return t;
  }).join("");
}
