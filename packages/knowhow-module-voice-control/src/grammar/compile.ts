/**
 * Pattern compiler for voice command grammar.
 *
 * Pattern syntax:
 *   literal word          — exact token (with edit-distance tolerance for ≥5 chars)
 *   [optional words]      — optional sequence
 *   (a|b|c)               — alternatives
 *   {slot:type}           — typed slot
 *   {slot:a|b|c}          — enum slot
 *   {slot:text}           — greedy text (must be last)
 */

export type PatternToken =
  | { kind: "literal"; word: string }
  | { kind: "optional"; tokens: PatternToken[][] }  // alternatives inside []
  | { kind: "alt"; alternatives: PatternToken[][] } // (a|b|c)
  | { kind: "slot"; name: string; type: string }     // {slot:type} — type is typename or pipe-separated enum
  | { kind: "enum-slot"; name: string; values: string[] }; // {slot:a|b|c}

/** Parse a pattern string into a list of PatternToken objects. */
export function compilePattern(pattern: string): PatternToken[] {
  return parseTokenSequence(pattern.trim());
}

function splitOnPipe(s: string): string[] {
  // Split on | but respect nested brackets/parens
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "|" && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function parseTokenSequence(pattern: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let i = 0;
  const src = pattern.trim();

  while (i < src.length) {
    // Skip leading whitespace
    while (i < src.length && src[i] === " ") i++;
    if (i >= src.length) break;

    const ch = src[i];

    if (ch === "[") {
      // Optional: [word1 word2] or [a|b]
      const end = findClose(src, i, "[", "]");
      const inner = src.slice(i + 1, end);
      const alts = splitOnPipe(inner).map((a) => parseTokenSequence(a.trim()));
      tokens.push({ kind: "optional", tokens: alts });
      i = end + 1;
    } else if (ch === "(") {
      // Alternatives: (a|b|c)
      const end = findClose(src, i, "(", ")");
      const inner = src.slice(i + 1, end);
      const alts = splitOnPipe(inner).map((a) => parseTokenSequence(a.trim()));
      tokens.push({ kind: "alt", alternatives: alts });
      i = end + 1;
    } else if (ch === "{") {
      // Slot: {name:type} or {name:a|b|c}
      const end = findClose(src, i, "{", "}");
      const inner = src.slice(i + 1, end);
      const colonIdx = inner.indexOf(":");
      if (colonIdx === -1) {
        // bare {name} treat as text slot
        tokens.push({ kind: "slot", name: inner.trim(), type: "text" });
      } else {
        const name = inner.slice(0, colonIdx).trim();
        const typeOrEnum = inner.slice(colonIdx + 1).trim();
        if (typeOrEnum.includes("|")) {
          // Enum slot
          tokens.push({ kind: "enum-slot", name, values: typeOrEnum.split("|").map((v) => v.trim()) });
        } else {
          tokens.push({ kind: "slot", name, type: typeOrEnum });
        }
      }
      i = end + 1;
    } else {
      // Literal word(s) — consume until space or special char
      let end = i;
      while (end < src.length && src[end] !== " " && src[end] !== "[" && src[end] !== "(" && src[end] !== "{") {
        end++;
      }
      const word = src.slice(i, end).toLowerCase();
      if (word) tokens.push({ kind: "literal", word });
      i = end;
    }
  }
  return tokens;
}

function findClose(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length; // malformed; just go to end
}
