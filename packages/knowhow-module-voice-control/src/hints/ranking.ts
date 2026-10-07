import { centerInside, rectOverlapFrac } from "./geometry";
import { deriveShortName, sortReadingOrder } from "./labels";
import { ACTIONABLE_ROLES, ROLE_LABEL, ROLE_PRIOR } from "./roles";
import { AXElement, Candidate, Rect } from "./types";

// ─── Viewport / clip filtering and dedup ─────────────────────────────────────

/**
 * Filter out off-screen / clipped / tiny AX elements and deduplicate.
 *
 * Rules:
 * - Drop elements where width or height <= 2 (invisible / height-1 sentinel
 *   used by virtualized lists for off-viewport items).
 * - Drop elements entirely outside the window bounds (if known).
 * - Deduplicate same role + name + rounded bounds (some apps report some
 *   elements twice in the tree).
 */
export function filterAndDedupeElements(elements: AXElement[], windowBounds?: Rect): AXElement[] {
  const seen = new Set<string>();
  const result: AXElement[] = [];
  for (const el of elements) {
    const b = el.bounds;
    if (!b) {
      result.push(el);
      continue;
    }
    // Drop tiny (invisible) elements
    if (b.width <= 2 || b.height <= 2) continue;
    // Drop elements entirely outside window bounds
    if (windowBounds) {
      if (
        b.x + b.width <= windowBounds.x ||
        b.y + b.height <= windowBounds.y ||
        b.x >= windowBounds.x + windowBounds.width ||
        b.y >= windowBounds.y + windowBounds.height
      ) continue;
    }
    // Dedup: same role + first 80 chars of name fields + rounded bounds
    const name = `${el.title ?? ""}|${el.description ?? ""}|${el.value ?? ""}`.slice(0, 80);
    const bKey = `${Math.round(b.x / 2) * 2},${Math.round(b.y / 2) * 2},${Math.round(b.width)},${Math.round(b.height)}`;
    const key = `${el.role}|${name}|${bKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(el);
  }
  return result;
}

// ─── Distance to rect (not center) ───────────────────────────────────────────

/** Distance from point to closest edge of rect. 0 if inside. */
export function distanceToRect(
  px: number,
  py: number,
  rect: Rect,
): number {
  const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.width));
  const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.height));
  return Math.sqrt(dx * dx + dy * dy);
}

/** Anisotropic Gaussian likelihood of a point belonging to a rect.
 * rx = horizontal error radius, ry = vertical error radius.
 */
export function gaussianLikelihood(
  px: number,
  py: number,
  rect: Rect,
  rx: number,
  ry: number,
): number {
  const dist = distanceToRect(px, py, rect);
  if (dist === 0) return 1.0;
  // For points outside, project to nearest edge for anisotropy
  const cx = Math.max(rect.x, Math.min(rect.x + rect.width, px));
  const cy = Math.max(rect.y, Math.min(rect.y + rect.height, py));
  const edgeDx = (px - cx) / rx;
  const edgeDy = (py - cy) / ry;
  return Math.exp(-0.5 * (edgeDx * edgeDx + edgeDy * edgeDy));
}

/** Size prior: prefer medium-sized elements over tiny or huge. */
function sizePrior(rect: Rect): number {
  const area = rect.width * rect.height;
  if (area < 50) return 0.2;
  if (area < 400) return 0.6;
  if (area < 5000) return 1.0;
  if (area < 40000) return 0.8;
  return 0.5;
}

function editDist(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Fuzzy word match between spoken query words and an element name.
 * Each query word counts if the name contains it, or (0.8) if a name word is
 * within one edit of it (whisper: "thea" vs "Theo"). A query whisper split on
 * punctuation ("t3 gg") also matches its run-together form ("t3.gg") via an
 * alphanumeric-only comparison.
 */
export function nameFuzzyScore(query: string[], name: string): number {
  query = query.map((w) => w.toLowerCase()).filter(Boolean);
  if (!query.length || !name) return 0;
  const lname = name.toLowerCase();
  const compactName = lname.replace(/[^a-z0-9]/g, "");
  const compactQuery = query.join("").replace(/[^a-z0-9]/g, "");
  if (query.length > 1 && compactQuery.length >= 3 && compactName.includes(compactQuery)) return 1;
  const nameWords = lname.split(/[^a-z0-9']+/).filter(Boolean);
  // Skip very short words (1 char) in per-word matching — they match too liberally
  // ("a" in query "a real hero" should not match every element containing the letter "a").
  const matchableQuery = query.filter((w) => w.length >= 2);
  let matches = 0;
  for (const word of matchableQuery) {
    if (lname.includes(word)) { matches++; continue; }
    if (word.length >= 4 && nameWords.some((nw) => Math.abs(nw.length - word.length) <= 1 && editDist(nw, word) <= 1)) {
      matches += 0.8;
    }
  }
  return matchableQuery.length > 0 ? matches / matchableQuery.length : 0;
}


/**
 * Small bonus (≤0.1) for names that match the query tightly: "glaucoma"
 * should prefer an element named "glaucoma" over a whole OCR line that merely
 * contains it.
 */
function nameSpecificity(query: string[], name: string, nScore: number): number {
  if (nScore <= 0 || !name) return 0;
  const words = name.trim().split(/\s+/).length;
  return 0.1 * Math.min(1, query.length / Math.max(1, words));
}

export interface RankOptions {
  gaze: { x: number; y: number };
  errorRadius: { x: number; y: number };
  elements: AXElement[];
  query?: string[];
  /** If true, include elements anywhere in the window (hints all). */
  wholeWindow?: boolean;
  /** Expansion factor if fewer than 3 candidates inside nominal radius. */
  expansionFactor?: number;
  /** Max candidates returned (default 20). */
  maxCandidates?: number;
  /**
   * Full parse (with wholeWindow): keep every distinct actionable element —
   * no per-name cap — and number them in reading order (top→bottom,
   * left→right) so "row 48" is predictable.
   */
  fullParse?: boolean;
  /** App-specific short-label hook (from an AppAdapter); undefined result = generic label. */
  labelFor?: (el: AXElement) => string | undefined;
}

export function rankCandidates(opts: RankOptions): Candidate[] {
  const { gaze, errorRadius, elements, query = [], wholeWindow = false } = opts;
  const rx = errorRadius.x;
  const ry = errorRadius.y;
  const expandFactor = opts.expansionFactor ?? 1.5;

  // Filter to actionable elements with bounds
  const actionable = elements.filter(
    (el) => ACTIONABLE_ROLES.has(el.role) && el.bounds && el.enabled !== false,
  );

  if (!actionable.length) return [];

  // Compute scores
  interface Scored {
    element: AXElement;
    gaze: number;
    name: number;
    role: number;
    size: number;
    total: number;
  }

  const scored: Scored[] = [];
  for (const el of actionable) {
    const rect = el.bounds!;
    const gScore = gaussianLikelihood(gaze.x, gaze.y, rect, rx, ry);
    if (!wholeWindow && gScore < 0.01) continue;
    // Include the derived short name (e.g. "like", "reply", "play rubber head")
    // so spoken commands match the action verb, not the raw "14 Likes. Like" string.
    const shortName = deriveShortName(el, opts.labelFor);
    // canonicalName: the primary human name — used for specificity (word count).
    // Use shortName if it's shorter/more specific than the raw title/description.
    const canonicalName = shortName || el.title || el.description || el.value || "";
    const nameWords = [el.title, el.description, el.value, shortName]
      .filter(Boolean)
      .join(" ");
    const nScore = query.length ? nameFuzzyScore(query, nameWords) : 0;
    // Inline words only compete when the spoken name matches them.
    if (el.role === "VXWord" && nScore < 0.5) continue;
    const rPrior = ROLE_PRIOR[el.role] ?? 0.5;
    const sPrior = sizePrior(rect);
    // Name match dominates when we have query words
    const total = query.length
      ? nScore * 0.5 + gScore * 0.3 + rPrior * 0.15 + sPrior * 0.05 + nameSpecificity(query, canonicalName, nScore)
      : wholeWindow
        // "hints all": label the most control-like things anywhere in the
        // window; gaze only breaks ties.
        ? rPrior * 0.6 + sPrior * 0.2 + gScore * 0.2
        : gScore * 0.6 + rPrior * 0.25 + sPrior * 0.15;
    scored.push({ element: el, gaze: gScore, name: nScore, role: rPrior, size: sPrior, total });
  }

  // If fewer than 3 within nominal radius and not wholeWindow, expand
  if (!wholeWindow && scored.length < 3) {
    const expanded: Scored[] = [];
    for (const el of actionable) {
      const rect = el.bounds!;
      const gScore = gaussianLikelihood(
        gaze.x, gaze.y, rect, rx * expandFactor, ry * expandFactor,
      );
      if (gScore < 0.01) continue;
      const nameWords = [el.title, el.description, el.value].filter(Boolean).join(" ");
      const nScore = query.length ? nameFuzzyScore(query, nameWords) : 0;
      if (el.role === "VXWord" && nScore < 0.5) continue;
      const rPrior = ROLE_PRIOR[el.role] ?? 0.5;
      const sPrior = sizePrior(rect);
      const total = query.length
        ? nScore * 0.5 + gScore * 0.3 + rPrior * 0.15 + sPrior * 0.05 + nameSpecificity(query, nameWords, nScore)
        : gScore * 0.6 + rPrior * 0.25 + sPrior * 0.15;
      expanded.push({ element: el, gaze: gScore, name: nScore, role: rPrior, size: sPrior, total });
    }
    if (expanded.length > scored.length) {
      scored.length = 0;
      scored.push(...expanded);
    }
  }

  // Sort by total score descending
  scored.sort((a, b) => b.total - a.total);

  // Drop near-duplicates (a text label inside a button, an AX link and its
  // static text, nested boxes) so every hint is a distinct target and the
  // label budget isn't spent twice on one control. Skipped for spoken-name
  // queries, where an inline word must survive inside its matching line.
  const kept: Scored[] = [];
  for (const s of scored) {
    if (query.length) { kept.push(s); continue; }
    const r = s.element.bounds!;
    const dup = kept.some((k) => {
      const kr = k.element.bounds!;
      return rectOverlapFrac(r, kr) > 0.6 || (centerInside(r, kr) && centerInside(kr, r));
    });
    if (!dup) kept.push(s);
  }

  // In "hints all" (wholeWindow) mode, apply spatial diversity: limit repeated
  // same-name buttons (e.g. 15 "Add to Liked Songs") so label budget spreads
  // across distinct items/regions.  Also drop giant container rows when their
  // children are already labelled.
  let diversified = kept;
  if (wholeWindow && !query.length) {
    // Cap per unique displayName (or role if no name): prefer spreading across regions.
    const nameCounts: Record<string, number> = {};
    // A full parse labels every repeated item (50 emails, 40 album cards);
    // the cap only applies to the sampled "hints all" view.
    const maxPerName = opts.fullParse ? Infinity : 3;
    diversified = [];
    for (const s of kept) {
      const b = s.element.bounds!;
      // Skip large containers (area > 20000) if more than 2 children are already kept.
      const area = b.width * b.height;
      if (area > 20000) {
        const childCount = diversified.filter((k) => {
          const kb = k.element.bounds!;
          return centerInside(kb, b) && kb !== b;
        }).length;
        if (childCount >= 2) continue;
      }
      const dn = deriveShortName(s.element, opts.labelFor) || `${s.element.role}`;
      nameCounts[dn] = (nameCounts[dn] ?? 0) + 1;
      if (nameCounts[dn] > maxPerName) continue;
      diversified.push(s);
    }
  }

  // Body-copy lines (VXLongText) are rarely what you want to click, and a
  // paragraph under your gaze would otherwise take every label. Without a
  // spoken name, allow at most ~1 in 5 of the list to be body text; the
  // rest are pushed behind every real control/label.
  let ordered = diversified;
  if (!query.length) {
    const cap = Math.max(2, Math.min(4, Math.floor((opts.maxCandidates ?? 20) / 8)));
    const head: Scored[] = [];
    const tail: Scored[] = [];
    let longCount = 0;
    for (const s of diversified) {  // iterate diversified (not kept) to preserve diversity
      if (s.element.role === "VXLongText" && ++longCount > cap) tail.push(s);
      else head.push(s);
    }
    ordered = [...head, ...tail];
  }

  // Full parse: everything is labelled, so number in reading order instead of
  // by score — "row 1" is the top of the window and numbers grow downwards.
  if (opts.fullParse && wholeWindow && !query.length) {
    ordered = sortReadingOrder(ordered.slice(0, opts.maxCandidates ?? 20), (s) => s.element.bounds!);
  }

  // Assign role-numbered labels (button 1, input 1, etc.)
  const roleCounters: Record<string, number> = {};
  const candidates: Candidate[] = ordered.slice(0, opts.maxCandidates ?? 20).map((s) => {
    const roleName = ROLE_LABEL[s.element.role] ?? s.element.role.toLowerCase().replace(/^ax/, "");
    roleCounters[roleName] = (roleCounters[roleName] ?? 0) + 1;
    const roleIndex = roleCounters[roleName];
    const label = `${roleName} ${roleIndex}`;
    const displayName = deriveShortName(s.element, opts.labelFor) || undefined;
    return {
      element: s.element,
      score: s.total,
      label,
      roleName,
      roleIndex,
      displayName,
    };
  });

  return candidates;
}

// ─── Ambiguity check ─────────────────────────────────────────────────────────

/** Returns true if the top two candidates are within 15% of each other. */
export function isAmbiguous(candidates: Candidate[]): boolean {
  if (candidates.length < 2) return false;
  const top = candidates[0].score;
  const second = candidates[1].score;
  if (top <= 0) return false;
  return (top - second) / top < 0.15;
}
