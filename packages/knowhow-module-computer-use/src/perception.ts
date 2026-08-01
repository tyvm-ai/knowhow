import { Point, Region } from "@tyvm/knowhow";

/**
 * Pure-TS perception primitives operating on a raw RGBA frame.
 *
 * These power the higher-level `computerUse*` detection tools (box/rectangle
 * detection with nesting, geometric shape matching, color blobs, template
 * match). Everything here is dependency-free (no native / OpenCV / OCR) so it
 * runs in the latency-sensitive automation loop and is trivially unit-testable
 * with synthetic frames.
 *
 * COORDINATE SPACES
 *  - A `Frame` is captured pixels; its (x,y) are IMAGE pixels.
 *  - Detectors return IMAGE-space bounds. The caller (ComputerService) maps
 *    image -> absolute desktop coordinates using the capture scale + region
 *    offset, exactly like findColorRegions already does.
 */

export interface Frame {
  width: number;
  height: number;
  /** RGBA, length = width * height * 4. */
  data: Buffer | Uint8ClampedArray | Uint8Array;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface BoxNode {
  /** Image-space bounds of the box. */
  bounds: Region;
  center: Point;
  area: number;
  /** Fill ratio of edge pixels along the rectangle perimeter (0..1). */
  edgeScore: number;
  /** Depth in the nesting hierarchy (0 = outermost). */
  depth: number;
  /** Indexes into the flat box list of directly-contained children. */
  children: BoxNode[];
}

export interface ShapeMatch {
  kind: "line-h" | "line-v" | "rect" | "square" | "circle" | "blob";
  bounds: Region;
  center: Point;
  area: number;
  score: number;
}

// ── color helpers ────────────────────────────────────────────────────────────

export function parseHex(color: string): RGB {
  const hex = color.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid color: ${color}`);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function px(frame: Frame, x: number, y: number): RGB {
  const i = (y * frame.width + x) * 4;
  return { r: frame.data[i], g: frame.data[i + 1], b: frame.data[i + 2] };
}

function colorMatch(a: RGB, b: RGB, tol: number): boolean {
  return (
    Math.abs(a.r - b.r) <= tol &&
    Math.abs(a.g - b.g) <= tol &&
    Math.abs(a.b - b.b) <= tol
  );
}

/** Luminance-based grayscale value 0..255. */
function luma(p: RGB): number {
  return (p.r * 299 + p.g * 587 + p.b * 114) / 1000;
}

// ── edge map (Sobel-ish gradient threshold) ─────────────────────────────────

/**
 * Build a boolean edge map from a frame. An edge is a pixel where the local
 * luminance gradient magnitude exceeds `threshold`. Used by box detection to
 * find rectangle borders regardless of fill color.
 */
export function edgeMap(frame: Frame, threshold = 40): Uint8Array {
  const { width: w, height: h } = frame;
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gray[y * w + x] = luma(px(frame, x, y));
    }
  }
  const edges = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[(y - 1) * w + (x - 1)] +
        gray[(y - 1) * w + (x + 1)] +
        -2 * gray[y * w + (x - 1)] +
        2 * gray[y * w + (x + 1)] +
        -gray[(y + 1) * w + (x - 1)] +
        gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] -
        2 * gray[(y - 1) * w + x] -
        gray[(y - 1) * w + (x + 1)] +
        gray[(y + 1) * w + (x - 1)] +
        2 * gray[(y + 1) * w + x] +
        gray[(y + 1) * w + (x + 1)];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag >= threshold) edges[y * w + x] = 1;
    }
  }
  return edges;
}


// ── box / rectangle detection with nesting ──────────────────────────────────

export interface FindBoxesOptions {
  /** Gradient threshold for the edge map (default 40). */
  edgeThreshold?: number;
  /** Minimum box width/height in image pixels (default 12). */
  minSize?: number;
  /** Maximum box width/height in image pixels (default = frame dimension). */
  maxSize?: number;
  /** Fraction of each border that must be edge pixels to count (default 0.6). */
  minEdgeScore?: number;
  /** Collapse boxes whose edges are within this many px of each other. */
  mergeTolerance?: number;
  /** Cap on returned boxes to bound cost (default 200). */
  maxBoxes?: number;
}

interface RawBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  edgeScore: number;
}

/** Fraction of a horizontal line [x0..x1] at row y that are edge pixels. */
function hLineScore(
  edges: Uint8Array,
  w: number,
  y: number,
  x0: number,
  x1: number,
  slack: number
): number {
  let hit = 0;
  const total = x1 - x0 + 1;
  for (let x = x0; x <= x1; x++) {
    let on = false;
    for (let dy = -slack; dy <= slack && !on; dy++) {
      const yy = y + dy;
      if (yy >= 0 && yy < edges.length / w && edges[yy * w + x]) on = true;
    }
    if (on) hit++;
  }
  return hit / total;
}

/** Fraction of a vertical line [y0..y1] at col x that are edge pixels. */
function vLineScore(
  edges: Uint8Array,
  w: number,
  h: number,
  x: number,
  y0: number,
  y1: number,
  slack: number
): number {
  let hit = 0;
  const total = y1 - y0 + 1;
  for (let y = y0; y <= y1; y++) {
    let on = false;
    for (let dx = -slack; dx <= slack && !on; dx++) {
      const xx = x + dx;
      if (xx >= 0 && xx < w && edges[y * w + xx]) on = true;
    }
    if (on) hit++;
  }
  return hit / total;
}

/**
 * Detect axis-aligned rectangular boxes (buttons, panels, modals, cards) and
 * arrange them into a containment hierarchy (which box is inside which).
 *
 * Approach: build an edge map, find strong horizontal edge rows and vertical
 * edge columns, then test candidate rectangles formed by pairs of h-rows and
 * v-cols for sufficient border coverage on all four sides. Finally nest boxes
 * by geometric containment so the caller can express queries like "the button
 * (small rect) inside this modal (large square)".
 */
export function findBoxes(frame: Frame, opts: FindBoxesOptions = {}): BoxNode[] {
  const { width: w, height: h } = frame;
  const edgeThreshold = opts.edgeThreshold ?? 40;
  const minSize = Math.max(4, Math.round(opts.minSize ?? 12));
  const maxW = Math.min(w, Math.round(opts.maxSize ?? w));
  const maxH = Math.min(h, Math.round(opts.maxSize ?? h));
  const minEdgeScore = opts.minEdgeScore ?? 0.6;
  const mergeTol = Math.max(1, Math.round(opts.mergeTolerance ?? 6));
  const maxBoxes = Math.max(1, Math.round(opts.maxBoxes ?? 200));
  const slack = 1;

  const edges = edgeMap(frame, edgeThreshold);

  // Candidate horizontal edge rows: rows with a high fraction of edge pixels.
  const rowScore = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (edges[y * w + x]) c++;
    rowScore[y] = c / w;
  }
  const colScore = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) if (edges[y * w + x]) c++;
    colScore[x] = c / h;
  }

  const rowThresh = 0.15;
  const colThresh = 0.15;
  const candRows = pickPeaks(rowScore, rowThresh, mergeTol);
  const candCols = pickPeaks(colScore, colThresh, mergeTol);

  const raw: RawBox[] = [];
  for (let a = 0; a < candRows.length; a++) {
    for (let b = a + 1; b < candRows.length; b++) {
      const y0 = candRows[a];
      const y1 = candRows[b];
      if (y1 - y0 < minSize || y1 - y0 > maxH) continue;
      for (let c = 0; c < candCols.length; c++) {
        for (let d = c + 1; d < candCols.length; d++) {
          const x0 = candCols[c];
          const x1 = candCols[d];
          if (x1 - x0 < minSize || x1 - x0 > maxW) continue;
          const top = hLineScore(edges, w, y0, x0, x1, slack);
          const bottom = hLineScore(edges, w, y1, x0, x1, slack);
          const left = vLineScore(edges, w, h, x0, y0, y1, slack);
          const right = vLineScore(edges, w, h, x1, y0, y1, slack);
          const score = (top + bottom + left + right) / 4;
          if (
            top >= minEdgeScore &&
            bottom >= minEdgeScore &&
            left >= minEdgeScore &&
            right >= minEdgeScore
          ) {
            raw.push({ x0, y0, x1, y1, edgeScore: score });
          }
        }
      }
    }
  }

  const merged = dedupeBoxes(raw, mergeTol)
    .sort((p, q) => q.edgeScore - p.edgeScore)
    .slice(0, maxBoxes);

  return nestBoxes(merged);
}

/** Find local maxima above `thresh`, merging peaks closer than `mergeTol`. */
function pickPeaks(score: Float32Array, thresh: number, mergeTol: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < score.length; i++) if (score[i] >= thresh) idx.push(i);
  const peaks: number[] = [];
  let group: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    if (group.length === 0 || idx[k] - group[group.length - 1] <= mergeTol) {
      group.push(idx[k]);
    } else {
      peaks.push(bestOfGroup(group, score));
      group = [idx[k]];
    }
  }
  if (group.length) peaks.push(bestOfGroup(group, score));
  return peaks;
}

function bestOfGroup(group: number[], score: Float32Array): number {
  let best = group[0];
  for (const g of group) if (score[g] > score[best]) best = g;
  return best;
}

function dedupeBoxes(boxes: RawBox[], tol: number): RawBox[] {
  const out: RawBox[] = [];
  for (const b of boxes) {
    const dup = out.find(
      (o) =>
        Math.abs(o.x0 - b.x0) <= tol &&
        Math.abs(o.y0 - b.y0) <= tol &&
        Math.abs(o.x1 - b.x1) <= tol &&
        Math.abs(o.y1 - b.y1) <= tol
    );
    if (dup) {
      if (b.edgeScore > dup.edgeScore) Object.assign(dup, b);
    } else {
      out.push(b);
    }
  }
  return out;
}

function toBoxNode(b: RawBox): BoxNode {
  const bounds: Region = {
    x: b.x0,
    y: b.y0,
    width: b.x1 - b.x0,
    height: b.y1 - b.y0,
  };
  return {
    bounds,
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    area: bounds.width * bounds.height,
    edgeScore: b.edgeScore,
    depth: 0,
    children: [],
  };
}

function contains(outer: Region, inner: Region, pad = 2): boolean {
  return (
    inner.x >= outer.x - pad &&
    inner.y >= outer.y - pad &&
    inner.x + inner.width <= outer.x + outer.width + pad &&
    inner.y + inner.height <= outer.y + outer.height + pad &&
    inner.width * inner.height < outer.width * outer.height
  );
}

/** Build the containment forest and set each node's depth + direct children. */
export function nestBoxes(boxes: RawBox[]): BoxNode[] {
  const nodes = boxes.map(toBoxNode).sort((a, b) => b.area - a.area);
  const roots: BoxNode[] = [];
  for (const node of nodes) {
    // Find the SMALLEST already-placed box that contains this node -> parent.
    let parent: BoxNode | null = null;
    for (const cand of nodes) {
      if (cand === node) continue;
      if (contains(cand.bounds, node.bounds)) {
        if (!parent || cand.area < parent.area) parent = cand;
      }
    }
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const setDepth = (n: BoxNode, d: number) => {
    n.depth = d;
    for (const c of n.children) setDepth(c, d + 1);
  };
  for (const r of roots) setDepth(r, 0);
  return roots;
}


// ── connected components (for color blobs + shape classification) ────────────

interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
  /** Perimeter-ish estimate: pixels with a non-member 4-neighbour. */
  edgeCount: number;
}

/**
 * Label connected components over a boolean mask (4-connectivity). Returns each
 * component's bounding box, pixel count, and a rough edge count for shape
 * classification. Iterative flood fill (stack) to avoid recursion limits.
 */
export function connectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  minPixels = 8
): Component[] {
  const seen = new Uint8Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = w,
      minY = h,
      maxX = -1,
      maxY = -1,
      count = 0,
      edgeCount = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      let isEdge = false;
      const neigh = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neigh) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          isEdge = true;
          continue;
        }
        const nidx = ny * w + nx;
        if (!mask[nidx]) {
          isEdge = true;
        } else if (!seen[nidx]) {
          seen[nidx] = 1;
          stack.push(nidx);
        }
      }
      if (isEdge) edgeCount++;
    }
    if (count >= minPixels) {
      comps.push({ minX, minY, maxX, maxY, count, edgeCount });
    }
  }
  return comps;
}

function maskByColor(frame: Frame, target: RGB, tol: number): Uint8Array {
  const { width: w, height: h } = frame;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (colorMatch(px(frame, x, y), target, tol)) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// ── color blobs ──────────────────────────────────────────────────────────────

export interface FindColorBlobsOptions {
  color: string;
  tolerance?: number;
  minPixels?: number;
  minSize?: number;
  maxSize?: number;
}

export function findColorBlobs(
  frame: Frame,
  opts: FindColorBlobsOptions
): ShapeMatch[] {
  const target = parseHex(opts.color);
  const tol = opts.tolerance ?? 16;
  const mask = maskByColor(frame, target, tol);
  const comps = connectedComponents(mask, frame.width, frame.height, opts.minPixels ?? 12);
  return comps
    .map((c) => componentToShape(c, "blob"))
    .filter((s) => sizeOk(s, opts.minSize, opts.maxSize));
}

// ── geometric shape matching ─────────────────────────────────────────────────

export interface FindShapesOptions {
  kind: ShapeMatch["kind"];
  color?: string;
  tolerance?: number;
  minPixels?: number;
  minSize?: number;
  maxSize?: number;
  /** For lines: required min length (px). */
  length?: number;
  /** For lines: max thickness (px). */
  thickness?: number;
  /** Aspect/shape score threshold to accept a candidate (default 0.6). */
  minScore?: number;
}

function componentToShape(c: Component, kind: ShapeMatch["kind"]): ShapeMatch {
  const bounds: Region = {
    x: c.minX,
    y: c.minY,
    width: c.maxX - c.minX + 1,
    height: c.maxY - c.minY + 1,
  };
  return {
    kind,
    bounds,
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    area: c.count,
    score: 1,
  };
}

function sizeOk(s: ShapeMatch, minSize?: number, maxSize?: number): boolean {
  const size = Math.max(s.bounds.width, s.bounds.height);
  return size >= (minSize ?? 1) && size <= (maxSize ?? Infinity);
}

/**
 * Classify connected components of a color mask into geometric shapes:
 * horizontal/vertical lines, rectangles, squares, circles, or generic blobs.
 */
export function findShapes(frame: Frame, opts: FindShapesOptions): ShapeMatch[] {
  const target = opts.color ? parseHex(opts.color) : null;
  const tol = opts.tolerance ?? 16;
  const { width: w, height: h } = frame;
  // Mask: by color if given, else by "non-background" edge/foreground via edges.
  let mask: Uint8Array;
  if (target) {
    mask = maskByColor(frame, target, tol);
  } else {
    mask = edgeMap(frame, 40);
  }
  const comps = connectedComponents(mask, w, h, opts.minPixels ?? 10);
  const minScore = opts.minScore ?? 0.6;
  const out: ShapeMatch[] = [];
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const fill = c.count / (bw * bh);
    const aspect = bw / bh;
    let match: ShapeMatch | null = null;
    switch (opts.kind) {
      case "line-h": {
        const thick = opts.thickness ?? 6;
        const len = opts.length ?? 12;
        if (bh <= thick && bw >= len && aspect >= 3) {
          match = componentToShape(c, "line-h");
          match.score = Math.min(1, aspect / 6);
        }
        break;
      }
      case "line-v": {
        const thick = opts.thickness ?? 6;
        const len = opts.length ?? 12;
        if (bw <= thick && bh >= len && 1 / aspect >= 3) {
          match = componentToShape(c, "line-v");
          match.score = Math.min(1, bh / bw / 6);
        }
        break;
      }
      case "square":
      case "rect": {
        const isSquare = Math.abs(1 - aspect) <= 0.25;
        const rectOk = fill >= minScore;
        if (rectOk && (opts.kind === "rect" || isSquare)) {
          match = componentToShape(c, opts.kind);
          match.score = fill;
        }
        break;
      }
      case "circle": {
        // circle area ~= pi/4 * bbox area; also near-square bbox.
        const circFill = c.count / (Math.PI / 4 * bw * bh);
        const isSquareish = Math.abs(1 - aspect) <= 0.3;
        if (isSquareish && circFill >= minScore && circFill <= 1.2) {
          match = componentToShape(c, "circle");
          match.score = Math.min(1, circFill);
        }
        break;
      }
      case "blob":
      default:
        match = componentToShape(c, "blob");
        break;
    }
    if (match && sizeOk(match, opts.minSize, opts.maxSize)) out.push(match);
  }
  return out.sort((a, b) => b.score - a.score || b.area - a.area);
}

// ── template match (find image -> center) ────────────────────────────────────

export interface TemplateMatchResult {
  found: boolean;
  center: Point;
  bounds: Region;
  score: number;
}

/**
 * Normalized grayscale template match via sliding-window SAD on a downscaled
 * grid, refined at full step. Good enough to locate a start/game-over button
 * crop. `step` trades speed for precision. Returns best match in IMAGE space.
 */
export function matchTemplate(
  frame: Frame,
  template: Frame,
  opts: { step?: number; threshold?: number } = {}
): TemplateMatchResult {
  const step = Math.max(1, Math.round(opts.step ?? 2));
  const threshold = opts.threshold ?? 0.85;
  const fw = frame.width;
  const fh = frame.height;
  const tw = template.width;
  const th = template.height;
  const grayF = grayscale(frame);
  const grayT = grayscale(template);
  let best = { score: -1, x: 0, y: 0 };
  const maxDiff = tw * th * 255;
  for (let y = 0; y + th <= fh; y += step) {
    for (let x = 0; x + tw <= fw; x += step) {
      let sad = 0;
      for (let ty = 0; ty < th; ty += step) {
        for (let tx = 0; tx < tw; tx += step) {
          const fv = grayF[(y + ty) * fw + (x + tx)];
          const tv = grayT[ty * tw + tx];
          sad += Math.abs(fv - tv);
        }
      }
      // Rescale SAD (sampled) to full and normalize to a 0..1 similarity.
      const sampled = Math.ceil(tw / step) * Math.ceil(th / step);
      const norm = 1 - (sad / sampled) / 255;
      if (norm > best.score) best = { score: norm, x, y };
    }
  }
  const bounds: Region = { x: best.x, y: best.y, width: tw, height: th };
  return {
    found: best.score >= threshold,
    score: Number(best.score.toFixed(4)),
    bounds,
    center: { x: best.x + tw / 2, y: best.y + th / 2 },
  };
}

function grayscale(frame: Frame): Float32Array {
  const { width: w, height: h } = frame;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    g[i] = (frame.data[j] * 299 + frame.data[j + 1] * 587 + frame.data[j + 2] * 114) / 1000;
  }
  return g;
}
