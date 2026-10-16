/**
 * Transcript normalisation.
 *
 * 1. Lowercase.
 * 2. Strip Whisper's trailing period/quotes.
 * 3. Fix known mishears from the table below.
 * 4. Collapse whitespace.
 */

/** Known Whisper mishears → canonical forms. */
const MISHEAR_TABLE: Array<[RegExp, string]> = [
  // Gaze / eye control
  [/\beyecontrol\b/g, "eye control"],
  [/\bi control\b/g, "eye control"],
  [/\beye controller\b/g, "eye control"],
  // Apps
  [/\bgo\s+sty\b/g, "ghostty"],
  [/\bghost\s*tee\b/g, "ghostty"],
  [/\bghosty\b/g, "ghostty"],
  [/\bcrome\b/g, "chrome"],
  [/\bcrown\b/g, "chrome"],
  // Numbers / homophones
  // Only AFTER a numbered noun ("monitor to" → "monitor two"). The old rule
  // rewrote "to" BEFORE those words, turning "move chrome to monitor 1" into
  // "move chrome two monitor 1" so it never matched.
  [/\b(monitor|pane|window|tab|desktop|screen|button|input|link|field)\s+(?:to|too)\b/g, "$1 two"],
  // "snap chrome monitor to write" (whisper) → "monitor two right"
  [/\b(monitor (?:one|two|three|[1-3]))\s+write\b/g, "$1 right"],
  // Common noise words that get transcribed
  [/\b(?:um|uh|er|ah|hmm)\b/g, ""],
  // Hints: whisper hears "hints" as "hands"/"hens"/"hits" ("show hands").
  [/^(?:show\s+)?(?:hands|hens|hinds)$/, "hints"],
  [/^(?:show\s+)?(?:hands|hens|hinds)\s+(all|here|on|off|mode)$/, "hints $1"],
  [/^(hide|clear|more|fewer|less|normal|show all)\s+(?:hands|hens|hinds)$/, "$1 hints"],
  [/^(?:hand|hands|hint|hints)\s+mode(\s+(?:on|off))?$/, "hint mode$1"],
  // "mouseover theo" / "mouse-over theo" → "mouse over theo"
  [/\bmouse-?over\b/g, "mouse over"],
  // Scroll
  [/\bscro ll\b/g, "scroll"],
  // "right" vs "write"
  [/\bwrite\b(?=\s+(?:click|pane|window))/g, "right"],
  // smarttype variants
  [/\bsmart[\s-]type\b/g, "smart type"],
  [/\bsmart[\s-]tight\b/g, "smart type"],
  [/\bsmarttype\b/g, "smart type"],
  // agenttype variants
  [/\bagent[\s-]type\b/g, "agent type"],
  [/\bagenttype\b/g, "agent type"],
  // Key presses: "hit enter" / "push tab" → "press …" (start of utterance
  // only, so dictated text after "type …" is untouched), and spoken counts
  // "press enter twice" / "press tab three times" → "press enter 2".
  [/^(?:hit|hits|push|tap)\s+/, "press "],
  [/^(press\s.+?)\s+(?:twice|two times)$/, "$1 2"],
  [/^(press\s.+?)\s+(?:three times|thrice)$/, "$1 3"],
  [/^(press\s.+?)\s+(\d+|four|five|six|seven|eight|nine|ten)\s+times$/, "$1 $2"],
];

/** A mishear rewrite contributed by a pack. */
export type NormaliseRule = [RegExp, string];

const packRules = new Map<string, NormaliseRule[]>();

/**
 * Register a pack's normaliser rules (idempotent per pack name). They run
 * before the generic table, in registration order.
 */
export function registerNormaliser(packName: string, rules: readonly NormaliseRule[]): void {
  packRules.set(packName, [...rules]);
}

/** Strip trailing period/comma/quotes that Whisper adds. */
function stripWhisperSuffix(text: string): string {
  // Remove surrounding quotes: "hello" → hello
  text = text.replace(/^["'](.+)["']$/, "$1");
  // Remove trailing period that Whisper adds to every utterance
  text = text.replace(/\.$/, "");
  return text;
}

/**
 * Normalise a raw Whisper transcript for command matching.
 *
 * - Lowercases
 * - Strips trailing Whisper punctuation/quotes
 * - Applies mishear table
 * - Collapses whitespace
 */
export function normaliseTranscript(text: string): string {
  let s = text.trim().toLowerCase();
  s = stripWhisperSuffix(s);
  for (const rules of packRules.values()) {
    for (const [pattern, replacement] of rules) s = s.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of MISHEAR_TABLE) {
    s = s.replace(pattern, replacement);
  }
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Tokenise a normalised string into lowercase words (strips punctuation except apostrophes). */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
