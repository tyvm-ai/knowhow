import { nameFuzzyScore } from "./ranking";
import { Candidate } from "./types";

// ─── Self-contained hint reference parser ────────────────────────────────────
// Used by packs/hints.ts so tests don't depend on core's grammar being ready.

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};

export interface HintRef {
  roleName?: string; // "button" | "input" | "link" | "check" | ...
  index?: number; // 1-based
  name?: string; // fuzzy name
}

/**
 * Parse a hint reference like "button 2", "input two", "save", "link 3 open in new tab".
 * Returns the role name, index, and/or name component.
 */
export function parseHintRef(text: string): HintRef {
  const t = text.toLowerCase().trim();
  const knownRoles = ["button", "input", "link", "check", "checkbox", "radio", "select", "tab", "item", "cell", "slider", "text", "icon"];

  let roleName: string | undefined;
  let index: number | undefined;
  let remaining = t;

  // Try to extract role
  for (const role of knownRoles) {
    if (remaining === role || remaining.startsWith(role + " ")) {
      roleName = role === "checkbox" ? "check" : role;
      remaining = remaining.slice(role.length).trim();
      break;
    }
  }

  // Try to extract number (digit or word)
  const digitMatch = remaining.match(/^(\d+)/);
  if (digitMatch) {
    index = parseInt(digitMatch[1], 10);
    remaining = remaining.slice(digitMatch[1].length).trim();
  } else {
    for (const [word, num] of Object.entries(NUMBER_WORDS)) {
      if (remaining === word || remaining.startsWith(word + " ")) {
        index = num;
        remaining = remaining.slice(word.length).trim();
        break;
      }
    }
  }

  // Remaining is the name
  const name = remaining || undefined;

  return { roleName, index, name };
}

/**
 * Resolve a HintRef against the current HintState candidates.
 * Returns the matched candidate or undefined.
 */
export function resolveHintRef(ref: HintRef, candidates: Candidate[], gaze?: { x: number; y: number }): Candidate | undefined {
  // If name is given and no role/index, do name search across all candidates
  if (ref.name && !ref.roleName && !ref.index) {
    const query = ref.name.toLowerCase().split(/\s+/);
    const dist = (c: Candidate) => {
      const b = c.element.bounds;
      if (!gaze || !b) return Infinity;
      return Math.hypot(b.x + b.width / 2 - gaze.x, b.y + b.height / 2 - gaze.y);
    };
    let best: Candidate | undefined;
    let bestScore = -1;
    for (const c of candidates) {
      const nameWords = [c.element.title, c.element.description, c.displayName].filter(Boolean).join(" ");
      const score = nameFuzzyScore(query, nameWords);
      // Equally good matches ("Explore" twice): take the one nearest your gaze
      // now; without a gaze, keep the earlier (higher-ranked) candidate.
      const tie = best !== undefined && Math.abs(score - bestScore) < 0.02;
      if ((!tie && score > bestScore) || (tie && dist(c) < dist(best!))) { best = c; bestScore = Math.max(score, bestScore); }
    }
    // Require most of the spoken words: "thea" must not grab an unrelated field.
    return bestScore >= 0.5 ? best : undefined;
  }

  // Filter by role name
  let pool = ref.roleName
    ? candidates.filter((c) => c.roleName === ref.roleName)
    : candidates;

  // Filter by index
  if (ref.index !== undefined) {
    pool = pool.filter((c) => c.roleIndex === ref.index);
  }

  // Filter by name (fuzzy)
  if (ref.name) {
    const query = ref.name.toLowerCase().split(/\s+/);
    pool = pool.filter((c) => {
      const nameWords = [c.element.title, c.element.description].filter(Boolean).join(" ");
      return nameFuzzyScore(query, nameWords) > 0.3;
    });
  }

  return pool[0];
}
