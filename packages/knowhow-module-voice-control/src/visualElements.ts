/**
 * Screenshot-based ("visual") element provider for the smart gaze selector.
 *
 * Accessibility is the best source of clickable elements, but it is often
 * missing: Chrome hides web content unless renderer accessibility is on,
 * canvas apps (Google Docs, games, Figma) expose nothing, and many Electron
 * apps report a sparse tree. This provider works from pixels only, using the
 * computer-use perception primitives that already exist:
 *
 *   - `readText` (macOS Vision OCR) → text lines + per-word boxes
 *   - `findRegions` (native Rust segmentation) → same-colour boxes
 *
 * and fuses them into pseudo accessibility elements so the existing ranking,
 * labelling, overlay and click code can use them unchanged:
 *
 *   VXButton  text sitting on its own box (button / tab / chip)
 *   VXInput   an empty wide box, titled by the nearest label text
 *   VXText    a short word or phrase with no enclosing control (menu items,
 *             links, list rows — anything you could click by its text)
 *   VXLongText a sentence / paragraph line (tweet body, article text); still
 *             addressable as "text N" but ranked well below labels
 *   VXIcon    a small square-ish box with no text (toolbar icons)
 *   VXWord    one word inside a longer text run; only used when the spoken
 *             name matches it ("click glaucoma" → the inline link word), never
 *             shown as a numbered hint
 *
 * The elements have no AX actions, so activation always moves the mouse to
 * the element centre and clicks.
 */

import type { AXElement, Rect } from "./smartSelector";

// ─── Inputs (structurally typed to avoid a hard dep on computer-use) ─────────

export interface OcrWordLike {
  text: string;
  bounds: Rect;
}

export interface OcrLineLike {
  text: string;
  confidence: number;
  bounds: Rect;
  words?: OcrWordLike[];
}

export interface BoxLike {
  bounds: Rect;
  children?: BoxLike[];
}

export interface VisualService {
  readText(opts: {
    region?: Rect;
    minConfidence?: number;
    recognitionLevel?: "fast" | "accurate";
    /** OCR tile overlap for large areas (computer-use readText). */
    tileOverlap?: number;
  }): Promise<OcrLineLike[]>;
  findRegions?(opts: {
    region?: Rect;
    mode?: "foreground" | "colors" | "panels";
    scale?: number;
    maxBoxes?: number;
    minSize?: number;
  }): Promise<BoxLike[]>;
}

export const VISUAL_ROLES = ["VXButton", "VXInput", "VXText", "VXLongText", "VXIcon", "VXWord"] as const;

/** Text runs with at least this many words are body copy (VXLongText), not labels. */
export const LONG_TEXT_WORDS = 6;

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r <= x || btm <= y) return undefined;
  return { x, y, width: r - x, height: btm - y };
}

function overlapFrac(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  return area(i) / Math.max(1, Math.min(area(a), area(b)));
}

function contains(outer: Rect, inner: Rect, tol = 3): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    inner.x + inner.width <= outer.x + outer.width + tol &&
    inner.y + inner.height <= outer.y + outer.height + tol
  );
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function round(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

export function flattenBoxes(boxes: BoxLike[]): Rect[] {
  const out: Rect[] = [];
  const walk = (b: BoxLike) => {
    out.push(b.bounds);
    for (const c of b.children ?? []) walk(c);
  };
  boxes.forEach(walk);
  return out;
}

// ─── Text segmentation ─────

/**
 * Which OCR words were written as @handle / #tag in the line text. Vision's
 * per-word strings drop the leading symbol, so align words to the line's
 * whitespace tokens by their letters/digits.
 */
function mentionFlags(lineText: string, words: OcrWordLike[]): boolean[] {
  const norm = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const tokens = lineText.split(/\s+/).filter((t) => norm(t));
  const flags = words.map(() => false);
  let ti = 0;
  for (let wi = 0; wi < words.length && ti < tokens.length; wi++) {
    const wn = norm(words[wi].text);
    if (!wn) continue;
    for (let k = ti; k < Math.min(tokens.length, ti + 3); k++) {
      const tn = norm(tokens[k]);
      if (tn === wn || tn.startsWith(wn) || wn.startsWith(tn)) {
        flags[wi] = /^[@#]/.test(tokens[k]);
        ti = k + 1;
        break;
      }
    }
  }
  return flags;
}

export interface TextSegment {
  text: string;
  bounds: Rect;
  words?: OcrWordLike[];
}

/** Text that is mostly letters/digits (filters OCR noise like "• • •", "c-)"). */
function isMeaningfulText(t: string): boolean {
  const alnum = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return alnum >= 2 && alnum / Math.max(1, t.replace(/\s/g, "").length) >= 0.5;
}

/**
 * Split OCR lines into clickable segments. Vision reports a whole menu bar
 * ("Insert Format Tools Help") as one line; words separated by a gap wider
 * than a normal space become separate segments, while ordinary phrases
 * ("Normal text", "Start Game") stay together.
 */
export function segmentOcrLines(lines: OcrLineLike[], gapFactor = 0.55): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const line of lines) {
    const words = (line.words ?? []).filter((w) => w.bounds && w.bounds.width > 0);
    if (!words.length) {
      if (isMeaningfulText(line.text)) segments.push({ text: line.text.trim(), bounds: line.bounds });
      continue;
    }
    words.sort((a, b) => a.bounds.x - b.bounds.x);
    const lineH = line.bounds.height || words[0].bounds.height;
    const tagged = mentionFlags(line.text, words);
    let cur: TextSegment = { text: words[0].text, bounds: { ...words[0].bounds }, words: [words[0]] };
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      const gap = w.bounds.x - (cur.bounds.x + cur.bounds.width);
      // @handles and #hashtags are their own links ("Eric @ericjung · 5h",
      // "Co-Founder @pdiscoveryio"): break before them, and after them.
      const linkBreak = tagged[i] || tagged[i - 1];
      if (gap > gapFactor * lineH || linkBreak) {
        segments.push(cur);
        cur = { text: w.text, bounds: { ...w.bounds }, words: [w] };
      } else {
        cur = { text: `${cur.text} ${w.text}`, bounds: union(cur.bounds, w.bounds), words: [...(cur.words ?? []), w] };
      }
    }
    segments.push(cur);
  }
  return segments.filter((s) => isMeaningfulText(s.text));
}

/**
 * Re-join OCR lines that were cut in two. readText OCRs large areas in
 * ~1200 px tiles (with a small overlap), so a whole-window scan splits any
 * text crossing a tile edge ("pwnma" + "chine", "Last updated 1 h" +
 * "our ago"), producing junk hints. Pieces on the same row that touch or
 * overlap horizontally are merged; words of the right piece already covered
 * by the left piece (the tile overlap) are dropped. Real separate items are
 * re-split later by segmentOcrLines' gap rule.
 */
export function mergeSplitLines(lines: OcrLineLike[], scanArea?: Rect): OcrLineLike[] {
  // readText's tile grid (see ComputerService.readText): 1200 px tiles
  // stepping 880 px (tileOverlap 320, as getVisualElements requests) or
  // 1176 px (default overlap). Near a tile edge the OCR drops the cut
  // glyphs, so the two pieces can be a word apart.
  const edges: number[] = [];
  if (scanArea) {
    for (const step of [880, 1176]) {
      for (let s = scanArea.x; s < scanArea.x + scanArea.width; s += step) {
        if (s > scanArea.x) edges.push(s);
        if (s + 1200 < scanArea.x + scanArea.width) edges.push(s + 1200);
      }
    }
  }
  const nearTileEdge = (from: number, to: number) => edges.some((e) => e >= from - 30 && e <= to + 30);
  const sorted = [...lines].sort((a, b) => a.bounds.x - b.bounds.x);
  const out: OcrLineLike[] = [];
  for (const line of sorted) {
    const h = line.bounds.height;
    const prev = out.find((o) => {
      const vo = Math.min(o.bounds.y + o.bounds.height, line.bounds.y + h) - Math.max(o.bounds.y, line.bounds.y);
      if (vo < 0.6 * Math.min(o.bounds.height, h)) return false;
      if (Math.abs(o.bounds.height - h) > 0.35 * Math.max(o.bounds.height, h)) return false;
      const right = o.bounds.x + o.bounds.width;
      const gap = line.bounds.x - right;
      // Touching / overlapping only, and the right piece must extend past.
      const maxGap = nearTileEdge(right, line.bounds.x) ? 1.5 * h : Math.min(6, 0.3 * h);
      return gap <= maxGap && gap >= -40 && line.bounds.x + line.bounds.width > right + 4;
    });
    if (!prev) {
      out.push({ ...line, words: line.words ? [...line.words] : undefined });
      continue;
    }
    const prevRight = prev.bounds.x + prev.bounds.width;
    const extraWords = (line.words ?? []).filter((w) => w.bounds.x + w.bounds.width / 2 > prevRight);
    // A word cut at the edge appears in both pieces ("hc" + "hour"); keep
    // the longer reading of horizontally overlapping words.
    const hits = (a: OcrWordLike, b: OcrWordLike) =>
      Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x) > 2;
    let prevWords = prev.words ?? [];
    let addWords = extraWords;
    for (const ew of extraWords) {
      const clash = prevWords.find((pw) => hits(pw, ew));
      if (!clash) continue;
      if (ew.text.length >= clash.text.length) prevWords = prevWords.filter((pw) => pw !== clash);
      else addWords = addWords.filter((w) => w !== ew);
    }
    const words = [...prevWords, ...addWords];
    const text = line.words?.length && prev.words?.length
      ? words.map((w) => w.text).join(" ")
      : `${prev.text} ${line.text}`;
    const idx = out.indexOf(prev);
    out[idx] = {
      text,
      confidence: Math.min(prev.confidence, line.confidence),
      bounds: union(prev.bounds, line.bounds),
      words: words.length ? words : undefined,
    };
  }
  return out;
}

/**
 * Drop text far smaller than the page's normal UI text: that is text inside
 * images/videos (a terminal screenshot in a tweet, chart axes), which OCR
 * reads but you can't click. Threshold: under 10 px, or under half the
 * median line height.
 */
export function dropTinyText(lines: OcrLineLike[]): OcrLineLike[] {
  if (lines.length < 4) return lines;
  const hs = lines.map((l) => l.bounds.height).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)];
  const min = Math.max(10, median * 0.5);
  return lines.filter((l) => l.bounds.height >= min);
}

// ─── Fusion ───────────────────────────────────────────────────────────────────

export interface FuseOptions {
  /** Area that was scanned (boxes covering most of it are backgrounds). */
  area?: Rect;
  /** Max icons to emit (they are the noisiest class). */
  maxIcons?: number;
}

/**
 * Pure fusion of OCR lines and detected boxes into pseudo AX elements.
 * Exported for unit tests.
 */
export function fuseVisualElements(
  lines: OcrLineLike[],
  boxes: Rect[],
  opts: FuseOptions = {},
): AXElement[] {
  const scanArea = opts.area ? area(opts.area) : Infinity;
  const segments = segmentOcrLines(dropTinyText(mergeSplitLines(lines, opts.area)));
  // Control-sized boxes: not a background panel, not a speck.
  const controls = boxes.filter(
    (b) =>
      b.width >= 12 &&
      b.height >= 12 &&
      b.height <= 90 &&
      b.width <= 700 &&
      area(b) < scanArea * 0.25,
  );

  const elements: AXElement[] = [];
  let n = 0;
  const push = (role: string, bounds: Rect, title?: string) => {
    elements.push({
      id: `vis:${n++}`,
      role,
      title,
      enabled: true,
      bounds: round(bounds),
      actions: [],
    });
  };

  // 1) Text segments → button (if on its own padded box) or text.
  const usedBoxes = new Set<Rect>();
  for (const seg of segments) {
    const segH = seg.bounds.height;
    let best: Rect | undefined;
    for (const b of controls) {
      if (!contains(b, seg.bounds)) continue;
      // Must be visibly padded around the text (a real button/chip), but not
      // a whole card or row of other content.
      const padded = b.height >= segH + 6 || b.width >= seg.bounds.width + 14;
      const tight = b.height <= Math.max(segH * 3.2, segH + 40) && b.width <= seg.bounds.width + 260;
      if (!padded || !tight) continue;
      // The box must not contain other text segments (then it is a group).
      const others = segments.filter((s) => s !== seg && contains(b, s.bounds)).length;
      if (others > 0) continue;
      if (!best || area(b) < area(best)) best = b;
    }
    if (best) {
      usedBoxes.add(best);
      push("VXButton", best, seg.text);
    } else {
      const pad = 3;
      const nWords = seg.words?.length ?? seg.text.trim().split(/\s+/).length;
      push(
        nWords >= LONG_TEXT_WORDS ? "VXLongText" : "VXText",
        { x: seg.bounds.x - pad, y: seg.bounds.y - pad, width: seg.bounds.width + 2 * pad, height: seg.bounds.height + 2 * pad },
        seg.text,
      );
      // Inline words of longer runs, so a spoken name can hit just that word.
      if ((seg.words?.length ?? 0) >= 3) {
        for (const w of seg.words!) {
          if (w.text.replace(/[^\p{L}\p{N}]/gu, "").length < 3) continue;
          push("VXWord", { x: w.bounds.x - 1, y: w.bounds.y - 2, width: w.bounds.width + 2, height: w.bounds.height + 4 }, w.text);
        }
      }
    }
  }

  const hasText = (b: Rect) => segments.some((s) => overlapFrac(b, s.bounds) > 0.3);

  // 2) Empty wide boxes → inputs, titled by the nearest label left/above.
  const inputs: Rect[] = [];
  for (const b of controls) {
    if (usedBoxes.has(b) || hasText(b)) continue;
    if (b.width < 100 || b.height < 20 || b.height > 70 || b.width < b.height * 3) continue;
    if (inputs.some((i) => overlapFrac(i, b) > 0.6)) continue;
    inputs.push(b);
  }
  for (const b of inputs) {
    let label: TextSegment | undefined;
    let bestD = Infinity;
    for (const s of segments) {
      const sc = center(s.bounds);
      // Above (within 60px, horizontally overlapping) or left (same row, within 220px).
      const above = s.bounds.y + s.bounds.height <= b.y + 4 && b.y - (s.bounds.y + s.bounds.height) < 60 && sc.x >= b.x - 20 && sc.x <= b.x + b.width;
      const left = s.bounds.x + s.bounds.width <= b.x + 4 && b.x - (s.bounds.x + s.bounds.width) < 220 && Math.abs(sc.y - (b.y + b.height / 2)) < b.height;
      if (!above && !left) continue;
      const d = Math.hypot(sc.x - b.x, sc.y - b.y);
      if (d < bestD) { bestD = d; label = s; }
    }
    push("VXInput", b, label?.text);
  }

  // 3) Small square-ish boxes without text → icons.
  const icons: Rect[] = [];
  for (const b of controls) {
    if (usedBoxes.has(b) || inputs.includes(b)) continue;
    if (b.width > 64 || b.height > 64) continue;
    const aspect = b.width / b.height;
    if (aspect < 0.5 || aspect > 2) continue;
    if (hasText(b)) continue;
    if (elements.some((e) => e.bounds && overlapFrac(e.bounds, b) > 0.5)) continue;
    // An icon directly left of a short label is the same control (nav rows
    // like "[house] Home", "[bell] Notifications"): one hint, on the text.
    if (iconBesideLabel(b, elements)) continue;
    // Prefer the outer box of nested duplicates (icon background vs glyph).
    const dupIdx = icons.findIndex((i) => overlapFrac(i, b) > 0.5);
    if (dupIdx >= 0) {
      if (area(b) > area(icons[dupIdx])) icons[dupIdx] = b;
      continue;
    }
    icons.push(b);
  }
  for (const b of icons.slice(0, opts.maxIcons ?? 60)) push("VXIcon", b);

  // 4) "•••" overflow menus: three tiny dots merge into one short, flat box
  // (needs the fine-grained foreground pass, minSize 2). Padded to a
  // clickable size.
  const dots: Rect[] = [];
  for (const b of boxes) {
    if (b.height < 3 || b.height > 9 || b.width < 12 || b.width > 36 || b.width < b.height * 2.5) continue;
    if (hasText(b)) continue;
    const c = center(b);
    if (dots.some((d) => Math.abs(center(d).x - c.x) < 8 && Math.abs(center(d).y - c.y) < 8)) continue;
    if (elements.some((e) => e.bounds && contains(e.bounds, b, 2) && e.role !== "VXLongText")) continue;
    dots.push(b);
  }
  for (const b of dots) {
    const c = center(b);
    push("VXIcon", { x: c.x - 13, y: c.y - 10, width: 26, height: 20 }, "more");
  }

  return elements;
}

/** True when `b` sits just left of a short text/button on the same row. */
function iconBesideLabel(b: Rect, elements: AXElement[]): boolean {
  // Only glyph-sized icons; avatars (~48 px) next to a name are their own target.
  if (b.width > 34 || b.height > 34) return false;
  const bc = b.y + b.height / 2;
  return elements.some((e) => {
    if (!e.bounds || (e.role !== "VXText" && e.role !== "VXButton")) return false;
    const t = e.bounds;
    const gap = t.x - (b.x + b.width);
    if (gap < -2 || gap > Math.max(36, b.width * 1.2)) return false;
    const tc = t.y + t.height / 2;
    return Math.abs(tc - bc) <= Math.max(b.height, t.height) * 0.45;
  });
}

// ─── Provider ─────────────────────────────────────────────────────────────────

interface VisualCache {
  key: string;
  at: number;
  elements: AXElement[];
}
let _cache: VisualCache | null = null;
const VISUAL_CACHE_TTL_MS = 800;

export function invalidateVisualCache(): void {
  _cache = null;
}

export interface VisualTimings {
  ocrMs: number;
  regionsMs: number;
  totalMs: number;
  lines: number;
  boxes: number;
}

export let lastVisualTimings: VisualTimings | undefined;

/**
 * Scan `scan` (desktop coords) and return pseudo AX elements. OCR and box
 * detection run in parallel; failures in either degrade gracefully.
 */
export async function getVisualElements(
  svc: VisualService,
  scan: Rect,
  opts: {
    log?: (msg: string) => void;
    recognitionLevel?: "fast" | "accurate";
    ttlMs?: number;
    minConfidence?: number;
  } = {},
): Promise<AXElement[]> {
  const r = round(scan);
  const key = `${r.x},${r.y},${r.width},${r.height}`;
  if (_cache && _cache.key === key && Date.now() - _cache.at < (opts.ttlMs ?? VISUAL_CACHE_TTL_MS)) {
    return _cache.elements;
  }
  const t0 = Date.now();
  let ocrMs = 0;
  let regionsMs = 0;
  // "accurate" costs ~0.3–0.8 s more than "fast" but reads small UI text
  // correctly and reports real confidences: garbled text inside images
  // (screenshots in tweets, charts) comes back at ~0.3 and is dropped,
  // while "fast" returns a flat 0.5 for everything, garbage included.
  // Large (whole-window) scans are OCR'd in tiles; a wide overlap lets the
  // neighbouring tile read text crossing an edge whole instead of returning
  // fragments ("pwnma", "Credenti"). mergeSplitLines stitches what's left.
  const ocrP = svc
    .readText({
      region: r,
      minConfidence: opts.minConfidence ?? 0.5,
      recognitionLevel: opts.recognitionLevel ?? "accurate",
      tileOverlap: 320,
    })
    .then((v) => { ocrMs = Date.now() - t0; return v; })
    .catch((e) => { opts.log?.(`[visual-hints] OCR failed: ${e}`); return [] as OcrLineLike[]; });
  // ~400 boxes per 800x1000 gaze area; whole windows need proportionally more.
  const maxBoxes = Math.min(2000, Math.max(400, Math.round((r.width * r.height) / 2000)));
  const boxesP = svc.findRegions
    ? Promise.all(
        [
          { mode: "colors" as const },
          { mode: "foreground" as const },
          // Fine pass for tiny glyphs ("•••" menus) the default pass drops.
          { mode: "foreground" as const, minSize: 2 },
        ].map((o) =>
          svc.findRegions!({ region: r, maxBoxes: maxBoxes, ...o }).catch((e) => {
            opts.log?.(`[visual-hints] findRegions(${o.mode}) failed: ${e}`);
            return [] as BoxLike[];
          }),
        ),
      ).then((sets) => { regionsMs = Date.now() - t0; return sets.flatMap(flattenBoxes); })
    : Promise.resolve([] as Rect[]);
  const [lines, boxes] = await Promise.all([ocrP, boxesP]);
  // Icon budget scales with the area (a whole feed has 100+ action icons).
  const maxIcons = Math.max(60, Math.round((r.width * r.height) / 20000));
  const elements = fuseVisualElements(lines, boxes, { area: r, maxIcons });
  lastVisualTimings = { ocrMs, regionsMs, totalMs: Date.now() - t0, lines: lines.length, boxes: boxes.length };
  opts.log?.(
    `[visual-hints] ${elements.length} elements from ${lines.length} OCR lines + ${boxes.length} boxes ` +
      `in ${lastVisualTimings.totalMs}ms (ocr ${ocrMs}ms, regions ${regionsMs}ms) over ${r.width}x${r.height}`,
  );
  _cache = { key, at: Date.now(), elements };
  return elements;
}

/** Scan area around the gaze point, clipped to `clip` (usually the front window). */
export function gazeScanArea(
  gaze: { x: number; y: number },
  errorRadius: { x: number; y: number },
  clip?: Rect,
  factor = 2,
): Rect {
  const w = Math.max(400, errorRadius.x * factor * 2);
  const h = Math.max(300, errorRadius.y * factor * 2);
  const box: Rect = { x: gaze.x - w / 2, y: gaze.y - h / 2, width: w, height: h };
  return (clip && intersect(box, clip)) || box;
}

/**
 * Drop visual elements that duplicate an existing AX element (their centre
 * falls inside an actionable AX element's bounds).
 */
export function dedupeAgainstAX(visual: AXElement[], ax: AXElement[], actionableRoles: Set<string>): AXElement[] {
  const axRects = ax
    .filter((e) => e.bounds && actionableRoles.has(e.role))
    .map((e) => e.bounds!) as Rect[];
  return visual.filter((v) => {
    if (!v.bounds) return false;
    const c = center(v.bounds);
    return !axRects.some((a) => c.x >= a.x && c.x <= a.x + a.width && c.y >= a.y && c.y <= a.y + a.height);
  });
}
