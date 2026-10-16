/**
 * Slot type registry and built-in matchers.
 *
 * Slot types convert one or more tokens from a normalised utterance
 * into a typed value. Modules can add custom slot types with
 * `registerSlotType(name, matcher)`.
 * Also accepts a legacy function-style matcher for backward compatibility.
 */

export interface SlotMatcher {
  /**
   * Try to consume tokens starting at `index`.
   * Returns { value, consumed } on success, undefined otherwise.
   * `consumed` is the number of tokens consumed (≥1).
   */
  match(tokens: string[], index: number, ctx?: Record<string, unknown>): { value: unknown; consumed: number } | undefined;
}

const registry = new Map<string, SlotMatcher>();

export function registerSlotType(
  name: string,
  matcher: SlotMatcher | ((text: string) => { value: unknown; consumed: string | number } | null),
): void {
  // Accept legacy function-style matchers (e.g. from hints pack)
  if (typeof matcher === "function") {
    const fn = matcher;
    registry.set(name, {
      match(tokens, index) {
        const text = tokens.slice(index).join(" ");
        const result = fn(text);
        if (!result) return undefined;
        const consumed = typeof result.consumed === "number" ? result.consumed : tokens.length - index;
        return { value: result.value, consumed };
      },
    });
    return;
  }
  registry.set(name, matcher);
}

export function getSlotMatcher(name: string): SlotMatcher | undefined {
  return registry.get(name);
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

const WORD_NUMS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // homophones
  to: 2, too: 2, for: 4,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

function matchNumber(tokens: string[], index: number): { value: number; consumed: number } | undefined {
  const t = tokens[index];
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return { value: parseInt(t, 10), consumed: 1 };
  if (t in ORDINALS) return { value: ORDINALS[t], consumed: 1 };
  if (t in WORD_NUMS) {
    const base = WORD_NUMS[t];
    // Handle "twenty one" etc.
    const next = tokens[index + 1];
    if (base >= 20 && next && next in WORD_NUMS && WORD_NUMS[next] < 10) {
      return { value: base + WORD_NUMS[next], consumed: 2 };
    }
    return { value: base, consumed: 1 };
  }
  return undefined;
}

registerSlotType("number", {
  match: matchNumber,
});

// ─── Direction ────────────────────────────────────────────────────────────────

const DIRS = new Set(["left", "right", "up", "down"]);
registerSlotType("dir", {
  match(tokens, index) {
    const t = tokens[index];
    if (t && DIRS.has(t)) return { value: t, consumed: 1 };
    return undefined;
  },
});

// ─── Hint ─────────────────────────────────────────────────────────────────────

/**
 * The `hint` slot type for smart gaze selection.
 *
 * Accepts ONE of:
 *   A) role [number]     — "button", "input 2", "link three", "check"
 *   B) name (≤3 tokens)  — "save", "email address", "submit button" when not
 *                          followed by any extra tokens (strict: entire remainder
 *                          consumed so "the button below" is rejected)
 *
 * Role words: button, input, field, link, check, box, checkbox, tab, menu,
 *             radio, select, slider, item, cell.
 * Number words: one–nine + ordinals.
 *
 * STRICT: the slot must consume ALL remaining tokens so that whisper
 * hallucinations like "click the button below thank you" don't match because
 * "the" is not a role word and there are trailing tokens after any name.
 * The pattern "{hint:hint}" appears at the END of each command pattern, and
 * matchPattern only accepts states where all tokens are consumed — so
 * a partial hint match that leaves trailing words automatically fails.
 */
export interface HintRef {
  roleName?: string;
  index?: number;
  name?: string;
}

const HINT_ROLE_WORDS = new Set([
  "button", "input", "field", "link", "check", "box", "checkbox",
  "menu", "radio", "select", "slider", "item", "cell",
]);

/**
 * Role words for screenshot-detected hints ("text 3", "icon 2"). They only
 * count as a role when followed by a number, so "type text hello" and
 * "click icon" keep their old meaning.
 */
const HINT_NUMBERED_ROLE_WORDS = new Set(["text", "icon", "row", "image"]);

const HINT_ROLE_CANONICAL: Record<string, string> = {
  field: "input",
  checkbox: "check",
  box: "check",
};

const HINT_NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};

/**
 * Label number after a role word: digits ("48"), "one".."ninety nine"
 * ("forty eight"), or ordinals. A full-window parse numbers well past nine,
 * so "row forty eight" must parse. Homophones ("to", "for") are not numbers here.
 */
function matchHintNumber(tokens: string[], index: number): { value: number; consumed: number } | undefined {
  const t = tokens[index];
  if (t === undefined) return undefined;
  if (/^\d+$/.test(t)) return { value: parseInt(t, 10), consumed: 1 };
  if (t in HINT_NUMBER_WORDS) return { value: HINT_NUMBER_WORDS[t], consumed: 1 };
  // "forty-eight" (hyphenated) → handled as two words
  const parts = t.split("-");
  if (parts.length === 2 && parts.every((p) => p in WORD_NUMS && !(p in WORD_HOMOPHONES))) {
    const [a, b] = parts.map((p) => WORD_NUMS[p]);
    if (a >= 20 && a % 10 === 0 && b > 0 && b < 10) return { value: a + b, consumed: 1 };
  }
  if (t in WORD_NUMS && !(t in WORD_HOMOPHONES)) {
    const base = WORD_NUMS[t];
    const next = tokens[index + 1];
    if (base >= 20 && next && next in WORD_NUMS && !(next in WORD_HOMOPHONES) && WORD_NUMS[next] > 0 && WORD_NUMS[next] < 10) {
      return { value: base + WORD_NUMS[next], consumed: 2 };
    }
    return { value: base, consumed: 1 };
  }
  return undefined;
}
const WORD_HOMOPHONES: Record<string, true> = { to: true, too: true, for: true, zero: true };

/**
 * Parse a hint reference from tokens starting at `index`.
 * Returns the HintRef and number of tokens consumed, or undefined.
 */
export function parseHintTokens(
  tokens: string[],
  index: number,
): { value: HintRef; consumed: number } | undefined {
  if (index >= tokens.length) return undefined;

  const tok = tokens[index];

  // Path A0: "text 3" / "icon two" (screenshot hints) — number required
  if (HINT_NUMBERED_ROLE_WORDS.has(tok)) {
    const num = matchHintNumber(tokens, index + 1);
    if (num !== undefined) return { value: { roleName: tok, index: num.value }, consumed: 1 + num.consumed };
  }

  // Path A: starts with a role word
  if (HINT_ROLE_WORDS.has(tok)) {
    const roleName = HINT_ROLE_CANONICAL[tok] ?? tok;
    let consumed = 1;
    let indexNum: number | undefined;

    // Optional trailing number
    const num = matchHintNumber(tokens, index + consumed);
    if (num) {
      indexNum = num.value;
      consumed += num.consumed;
    }

    return { value: { roleName, index: indexNum }, consumed };
  }

  // Path B: free name — consume exactly 1 token as the hint name.
  // We only consume a single token so that patterns like
  // "type in {hint:hint} {text:text}" can still match (the text slot
  // consumes the rest). The strictness (no trailing filler) is enforced
  // by matchPattern requiring ALL tokens to be consumed — if the next
  // pattern token can't consume the remaining words, the whole match fails.
  // Reject pure-digit tokens (numbers alone are not valid hint names;
  // they're likely repeat counts — "down 5", "tab 3").
  if (/^\d+$/.test(tok)) return undefined;
  // Reject filler/article words that indicate hallucination
  const FILLER = new Set(["the", "a", "an", "to", "in", "on", "at", "of", "below", "above", "here", "there", "please", "you", "thank", "thanks", "all", "this", "that", "it", "is", "are", "was", "be", "been", "being", "down", "up", "left", "right", "next", "prev", "previous", "cancel", "stop", "go"]);
  if (FILLER.has(tok)) return undefined;
  return { value: { name: tok }, consumed: 1 };
}

registerSlotType("hint", {
  match: parseHintTokens,
});

const HINT_PHRASE_FILLER = new Set(["the", "a", "an", "to", "in", "on", "at", "of", "below", "above", "here", "there", "please", "you", "thank", "thanks", "this", "that", "it", "is", "are", "was", "and", "me", "my"]);
/** Longest on-screen phrase accepted after "click" / "mouse over". */
const HINT_PHRASE_MAX_TOKENS = 6;

/**
 * Hint that may be a multi-word on-screen phrase: "click steal credentials",
 * "mouse over t3 gg". Only for patterns where the hint is the LAST slot (it
 * consumes every remaining token). Role references ("text 3", "button 2")
 * parse exactly as with `hint`. A phrase must not start with a filler word
 * and must not be only filler, so "click that" / "click the button below
 * thank you" never become name lookups.
 */
registerSlotType("hintphrase", {
  match(tokens, index) {
    const remaining = tokens.length - index;
    if (remaining <= 0) return undefined;
    const ref = parseHintTokens(tokens, index);
    if (ref && ref.consumed === remaining) return ref;
    if (remaining > HINT_PHRASE_MAX_TOKENS) return undefined;
    const words = tokens.slice(index);
    if (HINT_PHRASE_FILLER.has(words[0])) return undefined;
    if (words.every((w) => HINT_PHRASE_FILLER.has(w) || /^\d+$/.test(w))) return undefined;
    if (remaining === 1 && /^\d+$/.test(words[0])) return undefined;
    return { value: { name: words.join(" ") } as HintRef, consumed: remaining };
  },
});

/**
 * Song name phrase for "play <song>" commands. Like hintphrase but allows
 * articles and filler at the START (song names like "A Real Hero", "The Wall"),
 * while still rejecting all-filler phrases.
 */
const SONG_PHRASE_FILLER = new Set(["the", "a", "an", "to", "in", "on", "at", "of", "below", "above", "here", "there", "please", "you", "thank", "thanks", "this", "that", "it", "is", "are", "was", "and", "me", "my"]);
const SONG_PHRASE_MAX_TOKENS = 8;
registerSlotType("songphrase", {
  match(tokens, index) {
    const remaining = tokens.length - index;
    if (remaining <= 0) return undefined;
    if (remaining > SONG_PHRASE_MAX_TOKENS) return undefined;
    const words = tokens.slice(index);
    // Reject if ALL tokens are filler — "play the" should not match
    if (words.every((w) => SONG_PHRASE_FILLER.has(w) || /^\d+$/.test(w))) return undefined;
    return { value: { name: words.join(" ") } as HintRef, consumed: remaining };
  },
});

/**
 * Strict hint: a role word followed by a number ("button 2", "link three").
 * Used by the bare-hint command so ordinary words ("hello") can never click
 * an element on their own.
 */
registerSlotType("hintref", {
  match(tokens, index) {
    const r = parseHintTokens(tokens, index);
    if (!r || !r.value.roleName || r.value.index === undefined) return undefined;
    return r;
  },
});

// ─── Monitor ─────────────────────────────────────────────────────────────────

const MONITOR_ALIASES: Record<string, string | number> = {
  one: 1, "1": 1, two: 2, "2": 2, three: 3, "3": 3,
  left: "left", right: "right", this: "this", other: "other",
  primary: "primary", main: "primary",
};
registerSlotType("monitor", {
  match(tokens, index) {
    const t = tokens[index];
    if (t && t in MONITOR_ALIASES) return { value: MONITOR_ALIASES[t], consumed: 1 };
    return undefined;
  },
});

// ─── App ─────────────────────────────────────────────────────────────────────

/** Common spoken-name → bundle/display-name aliases that ship with voice-control (read-only). */
export const APP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  terminal: "Ghostty",
  ghostty: "Ghostty",
  chrome: "Google Chrome",
  browser: "Google Chrome",
  firefox: "Firefox",
  safari: "Safari",
  vscode: "Visual Studio Code",
  code: "Visual Studio Code",
  obsidian: "Obsidian",
  slack: "Slack",
  discord: "Discord",
  finder: "Finder",
  xcode: "Xcode",
  figma: "Figma",
  cursor: "Cursor",
  "go sty": "Ghostty",
  "ghost tee": "Ghostty",
  ghosty: "Ghostty",
  ghostie: "Ghostty",
  ghost: "Ghostty",
  ghosts: "Ghostty",
  "ghost t": "Ghostty",
  crome: "Google Chrome",
  krome: "Google Chrome",
  crown: "Google Chrome",
});

/**
 * Aliases the user confirmed at runtime ("ghosting" → Ghostty). The persistent source of truth is the
 * learned store (`services.learned`, key `app-name`); this overlay is the grammar's in-process view of it,
 * (re)built by the app-name recoverer's `onLearned`. The shipped table above is never mutated.
 */
const learnedAppAliases = new Map<string, string>();

export function addLearnedAppAlias(spoken: string, app: string): void {
  if (spoken && app && !(spoken in APP_ALIASES)) learnedAppAliases.set(spoken, app);
}

export function resetLearnedAppAliases(): void {
  learnedAppAliases.clear();
}

/** Shipped alias first, then a learned one. */
export function lookupAppAlias(spoken: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(APP_ALIASES, spoken) ? APP_ALIASES[spoken] : learnedAppAliases.get(spoken);
}

registerSlotType("app", {
  match(tokens, index) {
    // Try two-word app names first, then one-word.
    const twoWord = tokens.slice(index, index + 2).join(" ");
    const twoWordApp = lookupAppAlias(twoWord);
    if (twoWordApp) return { value: twoWordApp, consumed: 2 };
    const oneWord = tokens[index];
    const oneWordApp = oneWord ? lookupAppAlias(oneWord) : undefined;
    if (oneWordApp) return { value: oneWordApp, consumed: 1 };
    // Accept any capitalized or known app-looking word as a raw app name.
    if (oneWord && /^[a-z]/.test(oneWord) && oneWord.length > 2) {
      return { value: oneWord, consumed: 1 };
    }
    return undefined;
  },
});

// ─── Key ─────────────────────────────────────────────────────────────────────

const KEY_NAMES = new Set([
  "command", "cmd", "control", "ctrl", "option", "alt", "shift",
  "enter", "return", "escape", "esc", "tab", "space", "backspace", "delete", "del",
  "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown",
  "f1","f2","f3","f4","f5","f6","f7","f8","f9","f10","f11","f12",
  "a","b","c","d","e","f","g","h","i","j","k","l","m",
  "n","o","p","q","r","s","t","u","v","w","x","y","z",
  "0","1","2","3","4","5","6","7","8","9",
  "minus","dash","plus","equal","bracket","comma","period","slash","semicolon",
  "grave","tilde","backslash",
]);
const MOD_NAMES = new Set(["command","cmd","control","ctrl","option","alt","shift"]);
const MOD_CANONICAL: Record<string,string> = {
  command: "mod", cmd: "mod", control: "ctrl", ctrl: "ctrl", option: "alt", alt: "alt", shift: "shift",
};

registerSlotType("key", {
  match(tokens, index) {
    // Consume modifier tokens, then one key token.
    let i = index;
    const mods: string[] = [];
    while (i < tokens.length && MOD_NAMES.has(tokens[i])) {
      mods.push(MOD_CANONICAL[tokens[i]]);
      i++;
    }
    const key = tokens[i];
    if (!key || !KEY_NAMES.has(key)) return undefined;
    const consumed = i - index + 1;
    const value = [...mods, key].join("+");
    return { value, consumed };
  },
});

// ─── Text (greedy, must be last slot) ─────────────────────────────────────────

registerSlotType("text", {
  match(tokens, index) {
    if (index >= tokens.length) return undefined;
    return { value: tokens.slice(index).join(" "), consumed: tokens.length - index };
  },
});

// ─── Window ──────────────────────────────────────────────────────────────────

registerSlotType("window", {
  match(tokens, index) {
    const t = tokens[index];
    if (t === "window") {
      const next = tokens[index + 1];
      if (next === "this" || next === "here") return { value: "gaze", consumed: 2 };
      return { value: "focus", consumed: 1 };
    }
    if (t === "this") {
      const next = tokens[index + 1];
      if (next === "window") return { value: "gaze", consumed: 2 };
      return { value: "gaze", consumed: 1 };
    }
    return undefined;
  },
});
