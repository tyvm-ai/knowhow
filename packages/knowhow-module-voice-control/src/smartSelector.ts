/**
 * Smart gaze selector — AX-based element ranking, hint overlays, and the
 * SmartMouseController (magnetic cursor snapping to nearest AX element).
 *
 * Owned by the "hints" sub-agent.  No direct computer-use import at the
 * module level to avoid hard dependency cycles; ComputerService is passed in
 * at call sites via the ComputerUseAdapter interface.
 */

import { GazeSample } from "./eyeTracking";
import { enableAXForPid, shouldEnableWebAX, hasActionableWebContent } from "./axEnabler";
import { getChromeDOMElements } from "./chromeDomProvider";
import {
  getVisualElements,
  gazeScanArea,
  dedupeAgainstAX,
  VisualService,
} from "./visualElements";

// ─── Minimal re-export of types we depend on (contract-compatible) ───────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AXElement {
  id: string;
  role: string;
  title?: string;
  description?: string;
  value?: string;
  enabled?: boolean;
  bounds?: Rect;
  actions: string[];
}

// ─── Computer-use adapter interface (avoids hard dep on computer-use pkg) ────

export interface ComputerUseAdapter {
  accessibilityElements(opts?: {
    maxDepth?: number;
    maxElements?: number;
    interactiveOnly?: boolean;
  }): Promise<AXElement[]>;
  performAccessibilityAction(id: string, action: string): Promise<void>;
  setAccessibilityValue?(id: string, value: string): Promise<void>;
  showOverlay(primitives: OverlayPrimitive[]): Promise<void>;
  clearOverlay(): Promise<void>;
  moveMouse(p: { x: number; y: number }): Promise<void>;
  click(button?: "left" | "right" | "middle", opts?: { double?: boolean }): Promise<void>;
  typeText(text: string, opts?: { app?: string }): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;
  /** Optional: return the pid of the focused/active application (used to enable web AX). */
  getPid?(): Promise<number | null>;
  /** Optional screenshot perception (computer-use ComputerService) for visual hints. */
  readText?: VisualService["readText"];
  findRegions?: VisualService["findRegions"];
  getActiveWindow?(): Promise<{ app?: string; title?: string; bounds?: Rect } | null | undefined>;
}

/**
 * Where hint candidates come from:
 *  - "auto"   (default) accessibility + Chrome DOM; screenshot detection is
 *             added when those find fewer than 3 actionable elements near gaze
 *  - "ax"     accessibility + Chrome DOM only
 *  - "visual" screenshot detection only (OCR + box segmentation)
 *  - "both"   always merge both (visual duplicates of AX elements dropped)
 */
export type HintSource = "auto" | "ax" | "visual" | "both";

export interface OverlayPrimitive {
  kind: "rect" | "circle" | "line" | "point" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  color?: string;
  lineWidth?: number;
  /** Line end point (kind "line"). */
  x2?: number;
  y2?: number;
}

// ─── Actionable roles ─────────────────────────────────────────────────────────

const ACTIONABLE_ROLES = new Set([
  "AXButton",
  "AXLink",
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXComboBox",
  "AXMenuItem",
  "AXTab",
  "AXCell",
  "AXRow",
  "AXImage",
  "AXSlider",
  "AXSegmentedControl",
  "AXDisclosureTriangle",
  // Screenshot-detected pseudo roles (see visualElements.ts)
  "VXButton",
  "VXInput",
  "VXText",
  "VXLongText",
  "VXIcon",
  "VXWord",
]);

/** Short label prefix for each role. */
const ROLE_LABEL: Record<string, string> = {
  AXButton: "button",
  AXLink: "link",
  AXTextField: "input",
  AXTextArea: "input",
  AXSearchField: "input",
  AXCheckBox: "check",
  AXRadioButton: "radio",
  AXPopUpButton: "select",
  AXComboBox: "select",
  AXMenuItem: "item",
  AXTab: "tab",
  AXCell: "cell",
  AXRow: "row",
  AXImage: "image",
  AXSlider: "slider",
  VXButton: "button",
  VXInput: "input",
  VXText: "text",
  VXLongText: "text",
  VXIcon: "icon",
  VXWord: "text",
};

/** Score prior by role (higher = preferred). */
const ROLE_PRIOR: Record<string, number> = {
  AXButton: 1.0,
  AXTextField: 1.0,
  AXTextArea: 0.95,
  AXSearchField: 1.0,
  AXLink: 0.9,
  AXCheckBox: 0.9,
  AXRadioButton: 0.85,
  AXPopUpButton: 0.9,
  AXComboBox: 0.9,
  AXTab: 0.8,
  AXMenuItem: 0.75,
  AXSlider: 0.8,
  AXCell: 0.6,
  AXRow: 0.55,
  AXImage: 0.5,
  VXButton: 0.9,
  VXInput: 0.9,
  VXText: 0.75,
  VXLongText: 0.3, // body copy: rarely the click target, never crowd out labels
  VXIcon: 0.55,
  VXWord: 0.3, // below buttons/text so a matching control wins over an inline word
};

// ─── Candidate ─────────────────────────────────────────────────────────────

export interface Candidate {
  element: AXElement;
  score: number;
  label: string; // e.g. "button 1", "input 2"
  roleName: string; // e.g. "button"
  roleIndex: number; // 1-based within role group
  displayName?: string; // short human name from title/description
}

// ─── Hint state ───────────────────────────────────────────────────────────────

export interface HintState {
  candidates: Candidate[];
  timestamp: number;
  selectedIndex: number; // -1 = none
  ttlMs: number;
}

let _hintState: HintState | null = null;

export function getHintState(): HintState | null {
  if (!_hintState) return null;
  if (Date.now() - _hintState.timestamp > _hintState.ttlMs) {
    _hintState = null;
    return null;
  }
  return _hintState;
}

export function clearHintState(): void {
  _hintState = null;
  _hintHistory.length = 0;
}

export function setHintState(state: HintState): void {
  _hintState = state;
  _hintHistory.push(state);
  if (_hintHistory.length > 8) _hintHistory.shift();
}

/** Recent hint states (newest last) — hint mode replaces labels as gaze moves. */
const _hintHistory: HintState[] = [];

/**
 * The hint state that was on screen at time `ts` (speech onset). In hint mode
 * the labels refresh while you talk; "click text 3" must mean the "text 3"
 * you saw when you started speaking, not one drawn a moment later.
 */
export function getHintStateAt(ts: number | undefined): HintState | null {
  const current = getHintState();
  if (!current || ts === undefined) return current;
  for (let i = _hintHistory.length - 1; i >= 0; i--) {
    const h = _hintHistory[i];
    if (h.timestamp <= ts) return Date.now() - h.timestamp <= h.ttlMs ? h : null;
  }
  return current;
}

// ─── AX cache ─────────────────────────────────────────────────────────────────

interface AXCache {
  elements: AXElement[];
  timestamp: number;
  windowKey: string;
}

let _axCache: AXCache | null = null;
const AX_CACHE_TTL_MS = 500;

export function invalidateAXCache(): void {
  _axCache = null;
}

// ─── Viewport / clip filtering and dedup ─────────────────────────────────────

/**
 * Filter out off-screen / clipped / tiny AX elements and deduplicate.
 *
 * Rules:
 * - Drop elements where width or height <= 2 (invisible / height-1 sentinel
 *   used by virtualized lists for off-viewport items).
 * - Drop elements entirely outside the window bounds (if known).
 * - Deduplicate same role + name + rounded bounds (Spotify reports some
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

async function getCachedElements(
  adapter: ComputerUseAdapter,
  windowKey: string,
): Promise<AXElement[]> {
  const now = Date.now();
  if (
    _axCache &&
    _axCache.windowKey === windowKey &&
    now - _axCache.timestamp < AX_CACHE_TTL_MS
  ) {
    return _axCache.elements;
  }
  // Use larger depth + element budget so Spotify (depth 16–27) and Chrome
  // web content (depth up to 60) are fully captured. The Rust AX scanner
  // returns results in ~180–360 ms at these limits, within the 500 ms budget.
  // Accessibility can fail outright (e.g. "No focused accessibility
  // application" after a WindowServer restart). Never let that kill hints —
  // return an empty list so the screenshot fallback takes over.
  let rawElements: AXElement[] = [];
  try {
    rawElements = await adapter.accessibilityElements({
      interactiveOnly: false,
      maxDepth: 40,
      maxElements: 4000,
    });
  } catch (e) {
    console.warn(
      `[smart-selector] accessibility query failed (${(e as Error)?.message ?? e}); using screenshot hints only`,
    );
    return [];
  }
  // Get window bounds for viewport filtering
  let windowBounds: Rect | undefined;
  try {
    windowBounds = (await adapter.getActiveWindow?.())?.bounds ?? undefined;
  } catch { /* ignore */ }
  const elements = filterAndDedupeElements(rawElements, windowBounds);
  _axCache = { elements, timestamp: now, windowKey };
  return elements;
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

// Pointer memory lives in ./pointerMemory (shared with the click commands).
export { notePointerPlaced, clearPlacedPointer, recentPlacedPointer, recentPlacedCandidate } from "./pointerMemory";
import { notePointerPlaced } from "./pointerMemory";

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

function rectOverlapFrac(a: Rect, b: Rect): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r <= x || btm <= y) return 0;
  const inter = (r - x) * (btm - y);
  return inter / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

function centerInside(a: Rect, b: Rect): boolean {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}

// ─── Rank candidates ──────────────────────────────────────────────────────────

/**
 * Sort items top→bottom, left→right. Items whose vertical centres are within
 * `lineTolerance` px of the current line's first item share a line, so a row of
 * album cards or the cells of one email get consecutive numbers.
 */
export function sortReadingOrder<T>(items: T[], rectOf: (t: T) => Rect, lineTolerance = 12): T[] {
  const cy = (t: T) => { const r = rectOf(t); return r.y + r.height / 2; };
  const byY = [...items].sort((a, b) => cy(a) - cy(b));
  const out: T[] = [];
  let line: T[] = [];
  let lineY = 0;
  const flush = () => {
    line.sort((a, b) => rectOf(a).x - rectOf(b).x);
    out.push(...line);
    line = [];
  };
  for (const t of byY) {
    if (line.length && Math.abs(cy(t) - lineY) > lineTolerance) flush();
    if (!line.length) lineY = cy(t);
    line.push(t);
  }
  flush();
  return out;
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
    const shortName = deriveShortName(el);
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
      const dn = deriveShortName(s.element) || `${s.element.role}`;
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
    const displayName = deriveShortName(s.element) || undefined;
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

// ─── Short display name derivation ───────────────────────────────────────────

/**
 * Derive a short matchable display name from AX element name fields.
 *
 * Handles patterns seen in Spotify and X:
 *   "Play Rubber Head by Cliff Martinez" → "play rubber head"
 *   "More options for A Real Hero feat Electric Youth" → "more options"
 *   "Add to Liked Songs" → "add to liked songs"
 *   "120 Likes. Like" → "like" (verb after last ". ")
 *   "32 Replies. Reply" → "reply"
 *   "28 reposts. Repost" → "repost"
 *   "Share post" → "share post"
 *   "Bookmark" → "bookmark"
 *
 * Returns a lowercase string of <= 40 chars, suitable for fuzzy matching.
 */
export function deriveShortName(el: AXElement): string {
  const raw = (el.title || el.description || el.value || "").trim();
  if (!raw) return "";

  // X pattern: "N Likes. Like", "N Replies. Reply", "N reposts. Repost"
  // Extract the action word after the last ". "
  const dotSplit = raw.split(". ");
  if (dotSplit.length >= 2) {
    const last = dotSplit[dotSplit.length - 1].trim();
    // e.g. "Like", "Reply", "Repost"
    if (last && last.split(/\s+/).length <= 3) {
      return last.toLowerCase();
    }
  }

  // Spotify pattern: "Play <song> by <artist>" → "play <song>"
  const playByMatch = raw.match(/^play\s+(.+?)\s+by\s+.+$/i);
  if (playByMatch) {
    return `play ${playByMatch[1]}`.toLowerCase().slice(0, 40);
  }

  // "More options for <song>" → "more options"
  const moreForMatch = raw.match(/^more options for\s+.+/i);
  if (moreForMatch) return "more options";

  // "Add to Liked Songs" → keep as-is (short enough)
  return raw.toLowerCase().slice(0, 40);
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

// ─── Stable / unique labels ──────────────────────────────────────────────────

function sameTarget(a: Candidate, b: Candidate): boolean {
  const ra = a.element.bounds, rb = b.element.bounds;
  if (!ra || !rb || a.roleName !== b.roleName) return false;
  if ((a.displayName ?? "") !== (b.displayName ?? "")) return false;
  const dx = Math.abs(ra.x + ra.width / 2 - (rb.x + rb.width / 2));
  const dy = Math.abs(ra.y + ra.height / 2 - (rb.y + rb.height / 2));
  return (dx <= 16 && dy <= 16) || rectOverlapFrac(ra, rb) > 0.6;
}

/**
 * Relabel `next` so an element that was already labelled in `prev` keeps its
 * number ("text 11" stays "text 11" across hint-mode refreshes), and new
 * elements take the lowest number not used by a kept one. Labels in the
 * result are always unique. Order (ranking) is unchanged.
 */
export function stabilizeLabels(prev: Candidate[] | undefined, next: Candidate[]): Candidate[] {
  const used = new Map<string, Set<number>>();
  const take = (role: string, n: number) => {
    if (!used.has(role)) used.set(role, new Set());
    used.get(role)!.add(n);
  };
  const isUsed = (role: string, n: number) => !!used.get(role)?.has(n);
  const assigned: Array<number | undefined> = next.map(() => undefined);
  if (prev?.length) {
    const claimed = new Set<Candidate>();
    next.forEach((c, i) => {
      const match = prev.find((p) => !claimed.has(p) && sameTarget(p, c) && !isUsed(c.roleName, p.roleIndex));
      if (match) {
        claimed.add(match);
        assigned[i] = match.roleIndex;
        take(c.roleName, match.roleIndex);
      }
    });
  }
  return next.map((c, i) => {
    let idx = assigned[i];
    if (idx === undefined) {
      idx = 1;
      while (isUsed(c.roleName, idx)) idx++;
      take(c.roleName, idx);
    }
    return { ...c, roleIndex: idx, label: `${c.roleName} ${idx}` };
  });
}

/** Labels that appear more than once (should always be empty). */
export function duplicateLabels(candidates: Candidate[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const c of candidates) (seen.has(c.label) ? dups : seen).add(c.label);
  return [...dups];
}

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

// ─── Overlay helpers ──────────────────────────────────────────────────────────

/** Hint overlays persist until cleared ("hide hints"); pass a finite ttl to auto-clear. */
const HINT_OVERLAY_TTL_MS = Number.POSITIVE_INFINITY;

/**
 * How many hints to show. "few" keeps only the closest handful, "normal" is a
 * gaze-centred scan, "more" widens it, and "all" (the default) parses the whole
 * front window and labels every actionable element found.
 */
export type HintDensity = "few" | "normal" | "more" | "all";

/** Upper bound on labels for a full-window parse (effectively "everything"). */
export const FULL_PARSE_MAX_LABELS = 600;

export const HINT_DENSITY: Record<HintDensity, { labels: number; scanFactor: number; wholeWindow: boolean; full?: boolean }> = {
  few: { labels: 6, scanFactor: 1.5, wholeWindow: false },
  normal: { labels: 15, scanFactor: 2, wholeWindow: false },
  more: { labels: 30, scanFactor: 3, wholeWindow: false },
  // Full parse of the front window: every actionable element gets a label.
  all: { labels: FULL_PARSE_MAX_LABELS, scanFactor: 2, wholeWindow: true, full: true },
};

interface LabelBox { x: number; y: number; w: number; h: number }

/** Bright, mutually distinct colours for hint outlines + their tags. */
const HINT_PALETTE = ["#FFD700", "#00E5FF", "#FF5CCB", "#7CFF4F", "#FF9F1C", "#B69CFF"];

function boxesHit(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Build overlay primitives for the current candidates: a thin outline per
 * element plus a readable tag (dark pill + bold text). Names are included
 * only when few labels are shown, to keep dense pages legible. Tags try
 * above-left, inside-left and below-left positions to avoid colliding.
 */
export function buildHintOverlayPrimitives(candidates: Candidate[], maxLabels = 9): OverlayPrimitive[] {
  const shown = candidates.filter((c) => c.element.bounds).slice(0, maxLabels);
  const withNames = shown.length <= 9;
  const fontSize = shown.length > 20 ? 12 : 13;
  const charW = fontSize * 0.62;
  const tagH = fontSize + 6;
  const outlines: OverlayPrimitive[] = [];
  const tags: OverlayPrimitive[] = [];
  const placed: LabelBox[] = [];
  shown.forEach((c, i) => {
    const { x, y, width, height } = c.element.bounds!;
    // Each element's outline and tag share a colour, so it's obvious which box
    // a number belongs to even when a tag sits next to a neighbouring box.
    const color = HINT_PALETTE[i % HINT_PALETTE.length];
    outlines.push({ kind: "rect", x, y, width, height, color: `${color}CC`, lineWidth: shown.length > 20 ? 1 : 2 });
    const labelText = withNames && c.displayName ? `${c.label}: ${c.displayName}` : c.label;
    const w = Math.ceil(labelText.length * charW) + 8;
    // Inside the box first (unambiguous) when it fits; above it otherwise.
    const fitsInside = height >= tagH + 2 && width >= w + 2;
    const options: LabelBox[] = [
      ...(fitsInside ? [{ x: x + 1, y: y + 1, w, h: tagH }] : []), // inside, top-left
      { x, y: y - tagH - 1, w, h: tagH }, // above
      { x: x + 1, y: y + Math.max(0, (height - tagH) / 2), w, h: tagH }, // inside, left
      { x, y: y + height + 1, w, h: tagH }, // below
      { x: x - w - 2, y: y + (height - tagH) / 2, w, h: tagH }, // left of element
    ];
    const box = options.find((o) => o.y >= 0 && !placed.some((p) => boxesHit(o, p))) ?? options[fitsInside ? 0 : 1];
    placed.push(box);
    const midY = box.y + box.h / 2;
    // Rounded dark backing: a thick round-capped line acts as a filled pill.
    tags.push({
      kind: "line",
      x: box.x + tagH / 2,
      y: midY,
      x2: box.x + box.w - tagH / 2,
      y2: midY,
      color: "#000000D9",
      lineWidth: Math.min(32, tagH),
    });
    tags.push({ kind: "text", x: box.x + 4, y: box.y + 2, text: labelText, fontSize, color });
  });
  // Outlines first so tags draw on top of neighbouring outlines.
  return [...outlines, ...tags];
}

let _overlayClearTimer: NodeJS.Timeout | undefined;

export async function showHintOverlay(
  adapter: ComputerUseAdapter,
  candidates: Candidate[],
  ttlMs = HINT_OVERLAY_TTL_MS,
  maxLabels = 9,
): Promise<void> {
  const primitives = buildHintOverlayPrimitives(candidates, maxLabels);
  if (_overlayClearTimer) clearTimeout(_overlayClearTimer);
  await adapter.showOverlay(primitives);
  _overlayClearTimer = undefined;
  if (!Number.isFinite(ttlMs)) return;
  // Auto-clear after TTL (a newer overlay cancels the older timer).
  _overlayClearTimer = setTimeout(() => {
    _overlayClearTimer = undefined;
    adapter.clearOverlay().catch(() => undefined);
  }, ttlMs);
  _overlayClearTimer.unref?.();
}

// ─── Collect candidates ───────────────────────────────────────────────────────

export async function collectCandidates(
  adapter: ComputerUseAdapter,
  gaze: { x: number; y: number },
  errorRadius: { x: number; y: number },
  windowKey: string,
  opts: {
    query?: string[];
    wholeWindow?: boolean;
    log?: (msg: string) => void;
    /** App name (e.g. "Google Chrome") — used for Chrome DOM fallback when AX web content is empty. */
    appName?: string;
    /** Candidate sources (default "auto"; also KNOWHOW_HINT_SOURCE). */
    source?: HintSource;
    maxCandidates?: number;
    /** Screenshot scan area: around gaze (default) or the whole front window. */
    visualScan?: "gaze" | "window";
    /** Gaze scan size as a multiple of the error radius (default 2). */
    scanFactor?: number;
    /** Cache lifetime for screenshot results (default 800 ms). */
    visualTtlMs?: number;
    /** Full-window parse: label everything, number in reading order (see RankOptions.fullParse). */
    fullParse?: boolean;
  } = {},
): Promise<Candidate[]> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const source: HintSource =
    opts.source ?? (process.env.KNOWHOW_HINT_SOURCE as HintSource | undefined) ?? "auto";
  const rankWith = (els: AXElement[]) =>
    rankCandidates({
      gaze,
      errorRadius,
      elements: els,
      query: opts.query,
      wholeWindow: opts.wholeWindow,
      maxCandidates: opts.maxCandidates,
      fullParse: opts.fullParse,
    });

  if (source === "visual") {
    return rankWith(await collectVisualElements(adapter, gaze, errorRadius, !!opts.wholeWindow || opts.visualScan === "window", log, opts.visualTtlMs, opts.scanFactor));
  }

  let elements = await getCachedElements(adapter, windowKey);

  // Auto-enable web AX for Chromium/Electron if the tree looks sparse/empty
  if (shouldEnableWebAX(elements)) {
    let pid: number | null = null;
    try {
      pid = (await adapter.getPid?.()) ?? null;
    } catch { /* ignore */ }

    if (pid !== null) {
      const method = await enableAXForPid(pid, log);
      if (method !== "none" && method !== "failed") {
        log(`[smart-selector] Web AX enabled via ${method} for pid ${pid}; re-querying...`);
        // Invalidate cache and re-query now that accessibility is enabled
        invalidateAXCache();
        elements = await getCachedElements(adapter, windowKey);
        log(`[smart-selector] Re-query returned ${elements.length} elements`);
      } else {
        log(`[smart-selector] Web AX enable result: ${method} for pid ${pid}`);
      }
    } else {
      log("[smart-selector] No pid available; skipping web AX enable");
    }
  }

  // If AX still lacks actionable web content, try Chrome DOM provider
  let effectiveElements = elements;
  if (!hasActionableWebContent(elements) && opts.appName) {
    log(`[smart-selector] AX has no actionable web content; trying Chrome DOM provider for "${opts.appName}"...`);
    try {
      const domElements = await getChromeDOMElements(elements, opts.appName, log);
      if (domElements.length > 0) {
        log(`[smart-selector] Chrome DOM provider returned ${domElements.length} elements`);
        effectiveElements = [...elements, ...domElements];
      } else {
        log("[smart-selector] Chrome DOM provider returned no elements");
      }
    } catch (e) {
      log(`[smart-selector] Chrome DOM provider error: ${e}`);
    }
  }

  if (source === "ax") return rankWith(effectiveElements);

  // Screenshot fallback: when AX/DOM give fewer than 3 actionable elements in
  // the gaze area (or always, for "both"), add OCR/box-detected elements.
  let wantVisual = source === "both";
  if (!wantVisual) {
    const near = effectiveElements.filter(
      (el) =>
        ACTIONABLE_ROLES.has(el.role) &&
        el.bounds &&
        (opts.wholeWindow || gaussianLikelihood(gaze.x, gaze.y, el.bounds, errorRadius.x, errorRadius.y) > 0.3),
    ).length;
    // A full-window parse of an app whose AX tree is thin (album grids,
    // canvas-y web apps) needs the screenshot pass to cover the rest.
    const minAx = opts.fullParse ? 25 : 3;
    wantVisual = near < minAx;
    if (wantVisual) log(`[smart-selector] Only ${near} accessible element(s) ${opts.wholeWindow ? "in window" : "near gaze"}; adding screenshot hints`);
  }
  if (wantVisual) {
    const visual = await collectVisualElements(adapter, gaze, errorRadius, !!opts.wholeWindow || opts.visualScan === "window", log, opts.visualTtlMs, opts.scanFactor);
    effectiveElements = [...effectiveElements, ...dedupeAgainstAX(visual, effectiveElements, ACTIONABLE_ROLES)];
  }
  return rankWith(effectiveElements);
}

/** Run the screenshot provider over the gaze area (or whole front window). */
async function collectVisualElements(
  adapter: ComputerUseAdapter,
  gaze: { x: number; y: number },
  errorRadius: { x: number; y: number },
  wholeWindow: boolean,
  log: (msg: string) => void,
  ttlMs?: number,
  scanFactor?: number,
): Promise<AXElement[]> {
  if (typeof adapter.readText !== "function") {
    log("[smart-selector] Screenshot hints unavailable (no readText on the computer-use adapter)");
    return [];
  }
  let windowBounds: Rect | undefined;
  try {
    windowBounds = (await adapter.getActiveWindow?.())?.bounds ?? undefined;
  } catch { /* ignore */ }
  const scan = wholeWindow && windowBounds
    ? windowBounds
    : gazeScanArea(gaze, errorRadius, windowBounds, scanFactor);
  try {
    return await getVisualElements(adapter as VisualService, scan, { log, ttlMs });
  } catch (e) {
    log(`[smart-selector] Screenshot hints failed: ${e}`);
    return [];
  }
}

// ─── Gaze correction POST ──────────────────────────────────────────────────

export async function postGazeCorrection(
  target: { x: number; y: number },
  hubUrl = "http://127.0.0.1:7465",
): Promise<void> {
  try {
    await fetch(`${hubUrl}/api/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // best-effort
  }
}

// ─── Element actions ──────────────────────────────────────────────────────────

/**
 * Re-query the AX tree and find an element matching the original by
 * role + name + approx bounds (centre within 30px). Used when the stored
 * element ID may have gone stale after layout changes.
 */
async function resolveStaleElement(
  adapter: ComputerUseAdapter,
  candidate: Candidate,
): Promise<Candidate> {
  try {
    const fresh = await adapter.accessibilityElements({
      interactiveOnly: false,
      maxDepth: 40,
      maxElements: 4000,
    });
    const el = candidate.element;
    const ob = el.bounds;
    const name = (el.title ?? el.description ?? el.value ?? "").toLowerCase();
    const role = el.role;
    const found = fresh.find((f) => {
      if (f.role !== role) return false;
      const fname = (f.title ?? f.description ?? f.value ?? "").toLowerCase();
      if (fname !== name) return false;
      if (ob && f.bounds) {
        const ocx = ob.x + ob.width / 2;
        const ocy = ob.y + ob.height / 2;
        const fcx = f.bounds.x + f.bounds.width / 2;
        const fcy = f.bounds.y + f.bounds.height / 2;
        return Math.hypot(fcx - ocx, fcy - ocy) <= 30;
      }
      return true;
    });
    if (found) {
      return { ...candidate, element: found };
    }
  } catch {
    // ignore — use original
  }
  return candidate;
}

export async function activateElement(
  adapter: ComputerUseAdapter,
  candidate: Candidate,
  action: "click" | "focus" | "check" | "rightClick" = "click",
): Promise<void> {
  let resolvedCandidate = candidate;
  let el = candidate.element;
  const bounds = el.bounds;

  if (action === "click" || action === "check") {
    // Prefer AXPress for AX-sourced elements. Before pressing, re-query to
    // handle stale tree paths (layout changes after hover/scroll can invalidate
    // the cached id). VX* pseudo-roles are visual-only — no re-query needed.
    if (el.actions.includes("AXPress")) {
      if (el.id && !el.role.startsWith("VX")) {
        resolvedCandidate = await resolveStaleElement(adapter, candidate);
        el = resolvedCandidate.element;
      }
      await adapter.performAccessibilityAction(el.id, "AXPress");
    } else if (bounds) {
      const cx = Math.round(bounds.x + bounds.width / 2);
      const cy = Math.round(bounds.y + bounds.height / 2);
      await adapter.moveMouse({ x: cx, y: cy });
      // Let the page see the hover first; web apps (X profile links, menus)
      // can ignore a click that arrives in the same instant as the move.
      await new Promise((r) => setTimeout(r, 60));
      await adapter.click("left");
      notePointerPlaced({ x: cx, y: cy }, resolvedCandidate);
    }
    if (bounds) {
      await postGazeCorrection({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    }
  } else if (action === "focus") {
    // Try AXRaise or AXFocused for inputs
    if (el.actions.includes("AXRaise")) {
      await adapter.performAccessibilityAction(el.id, "AXRaise");
    } else if (bounds) {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      await adapter.moveMouse({ x: cx, y: cy });
      await adapter.click("left");
    }
    if (bounds) {
      await postGazeCorrection({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    }
  } else if (action === "rightClick") {
    if (bounds) {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      await adapter.moveMouse({ x: cx, y: cy });
      await adapter.click("right");
      await postGazeCorrection({ x: cx, y: cy });
    }
  }
}

// ─── Play <song> lookup ───────────────────────────────────────────────────────

/**
 * Find the "Play <song> by <artist>" AXButton for a given song name query.
 * Searches the full window AX tree via a fresh query (not the cache).
 * Returns the best matching Candidate, or the nearest AXRow if no play button
 * matches well enough, or undefined.
 *
 * @param adapter   The computer-use adapter
 * @param songQuery Words from the spoken song name (e.g. ["a", "real", "hero"])
 * @param gaze      Current gaze point for distance-based tie-breaking
 */
export async function findPlayButton(
  adapter: ComputerUseAdapter,
  songQuery: string[],
  gaze: { x: number; y: number },
): Promise<Candidate | undefined> {
  let elements: AXElement[];
  try {
    elements = await adapter.accessibilityElements({
      interactiveOnly: false,
      maxDepth: 40,
      maxElements: 4000,
    });
  } catch {
    return undefined;
  }

  // Filter to AXButton elements that support AXPress
  const playButtons = elements.filter(
    (el) => el.role === "AXButton" && el.actions.includes("AXPress"),
  );

  // Score by song name match (shortName for play buttons is "play <song>")
  let bestBtn: AXElement | undefined;
  let bestScore = 0;
  for (const btn of playButtons) {
    const shortName = deriveShortName(btn);
    // Strip "play " prefix so the query "a real hero" matches "play a real hero"
    const songPart = shortName.startsWith("play ") ? shortName.slice(5) : shortName;
    const fullScore = nameFuzzyScore(songQuery, songPart);
    // Also try matching against the full description ("Play X by Y") directly
    const rawName = (btn.title ?? btn.description ?? "").toLowerCase();
    const rawScore = nameFuzzyScore(songQuery, rawName);
    const score = Math.max(fullScore, rawScore);
    if (score > bestScore) {
      bestScore = score;
      bestBtn = btn;
    }
  }

  if (bestBtn && bestScore >= 0.4) {
    return {
      element: bestBtn,
      score: bestScore,
      label: "button 1",
      roleName: "button",
      roleIndex: 1,
      displayName: deriveShortName(bestBtn),
    };
  }

  // Fallback: find nearest AXRow that contains the song name in its title
  const filtered = filterAndDedupeElements(elements);
  return rankCandidates({
    gaze,
    errorRadius: { x: 400, y: 400 },
    elements: filtered,
    query: songQuery,
    wholeWindow: true,
    maxCandidates: 1,
  })[0];
}

// ─── Smart mouse controller ───────────────────────────────────────────────────

export interface SmartMouseOptions {
  pollHz?: number;
  alpha?: number;
  deadZone?: number;
  snapDeadZone?: number; // hysteresis: don't switch candidates unless distance > this
  hubUrl?: string;
  errorRadius?: { x: number; y: number };
}

export class SmartMouseController {
  private timer?: NodeJS.Timeout;
  private smoothX = 0;
  private smoothY = 0;
  private hasFirst = false;
  // Module-level singleton reference for cross-command stop support
  static _instance: SmartMouseController | null = null;

  private readonly alpha: number;
  private readonly deadZone: number;
  private readonly snapDeadZone: number;
  private readonly hubUrl: string;
  private readonly errorRadius: { x: number; y: number };
  private lastTargetId: string | undefined;
  private busy = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly adapter: ComputerUseAdapter,
    private readonly getWindowKey: () => string,
    private readonly options: SmartMouseOptions = {},
  ) {
    this.alpha = options.alpha ?? 0.3;
    this.deadZone = options.deadZone ?? 4;
    this.snapDeadZone = options.snapDeadZone ?? 30;
    this.hubUrl = options.hubUrl ?? "http://127.0.0.1:7465";
    this.errorRadius = options.errorRadius ?? { x: 200, y: 260 };
  }

  isRunning(): boolean {
    return !!this.timer;
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.round(1000 / (this.options.pollHz ?? 30));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.hasFirst = false;
    this.lastTargetId = undefined;
  }

  private async tick(): Promise<void> {
    // Never overlap ticks: a screenshot scan can take longer than the poll interval.
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tickInner();
    } finally {
      this.busy = false;
    }
  }

  private async tickInner(): Promise<void> {
    try {
      const res = await fetch(`${this.hubUrl}/api/gaze`, {
        signal: AbortSignal.timeout(100),
      });
      if (!res.ok) return;
      const sample = await res.json() as { x: number; y: number };
      if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return;

      if (!this.hasFirst) {
        this.smoothX = sample.x;
        this.smoothY = sample.y;
        this.hasFirst = true;
      } else {
        this.smoothX = this.alpha * sample.x + (1 - this.alpha) * this.smoothX;
        this.smoothY = this.alpha * sample.y + (1 - this.alpha) * this.smoothY;
      }

      // Get candidates near gaze
      const candidates = await collectCandidates(
        this.adapter,
        { x: this.smoothX, y: this.smoothY },
        this.errorRadius,
        this.getWindowKey(),
        // Scan the whole window once and reuse it for a few seconds so the
        // magnetic cursor stays responsive when it relies on screenshots.
        { visualScan: "window", visualTtlMs: 3000, log: () => undefined },
      );

      if (!candidates.length) {
        // Fall back to raw gaze position
        const dx = Math.abs(this.smoothX - this.lastX);
        const dy = Math.abs(this.smoothY - this.lastY);
        if (dx >= this.deadZone || dy >= this.deadZone) {
          this.lastX = Math.round(this.smoothX);
          this.lastY = Math.round(this.smoothY);
          await this.adapter.moveMouse({ x: this.lastX, y: this.lastY });
        }
        return;
      }

      const best = candidates[0];
      const bounds = best.element.bounds;
      if (!bounds) return;
      const targetX = Math.round(bounds.x + bounds.width / 2);
      const targetY = Math.round(bounds.y + bounds.height / 2);

      // Hysteresis: only switch candidate if the new one is significantly different
      if (
        this.lastTargetId !== undefined &&
        best.element.id !== this.lastTargetId
      ) {
        const dist = Math.sqrt(
          (targetX - this.lastX) ** 2 + (targetY - this.lastY) ** 2,
        );
        if (dist < this.snapDeadZone) return;
      }

      this.lastTargetId = best.element.id;
      const dx = Math.abs(targetX - this.lastX);
      const dy = Math.abs(targetY - this.lastY);
      if (dx < this.deadZone && dy < this.deadZone) return;

      this.lastX = targetX;
      this.lastY = targetY;
      await this.adapter.moveMouse({ x: targetX, y: targetY });
    } catch {
      // ignore transient errors
    }
  }

  currentPosition(): { x: number; y: number } | undefined {
    if (!this.hasFirst) return undefined;
    return { x: this.lastX, y: this.lastY };
  }
}

// ─── Chrome AX detection ─────────────────────────────────────────────────────

/** Detect if Chrome AX tree is empty/sparse and log a hint. */
export function detectChromeAXStatus(
  elements: AXElement[],
  log: (msg: string) => void,
): "ok" | "sparse" | "empty" {
  const actionable = elements.filter((el) => ACTIONABLE_ROLES.has(el.role) && el.bounds);
  if (actionable.length === 0) {
    log(
      "[smart-selector] Chrome AX tree is EMPTY — enable renderer accessibility: " +
      "launch Chrome with --force-renderer-accessibility, or visit chrome://accessibility and enable.",
    );
    return "empty";
  }
  if (actionable.length < 3) {
    log("[smart-selector] Chrome AX tree is SPARSE — may need renderer accessibility enabled.");
    return "sparse";
  }
  return "ok";
}
