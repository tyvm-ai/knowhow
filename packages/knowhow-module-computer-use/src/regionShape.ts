import { Point, Region } from "@tyvm/knowhow";

/**
 * Flexible region shapes.
 *
 * A plain named region used to be a single axis-aligned rectangle
 * ({x,y,width,height}). That is too limiting for real UIs: the "playable" area
 * is often NOT a rectangle — it's "the chrome surface MINUS the toolbar/tabs",
 * a circle in the middle, an L / maze shape, or an arbitrary union of pieces
 * with some holes punched out.
 *
 * `RegionShape` models that as a small algebra of primitives plus boolean
 * composition, all in ABSOLUTE DESKTOP coordinates:
 *
 *   - rect:     an axis-aligned rectangle (the classic case)
 *   - circle:   a filled circle (cx, cy, r)
 *   - ellipse:  a filled axis-aligned ellipse
 *   - polygon:  an arbitrary closed polygon (points[])
 *   - union:    the OR of several shapes (a maze / multi-piece area)
 *   - subtract: base shape MINUS a set of holes ("everywhere in X except Y, Z")
 *
 * Everything reduces to two operations the rest of the system needs:
 *   - pointInShape(shape, p)  -> is a desktop point inside the shape?
 *   - shapeBounds(shape)      -> the tight axis-aligned bounding Region
 *
 * Detectors/observers/automations can keep asking for a bounding Region (cheap,
 * back-compat) and additionally use `pointInShape` to reject hits that land in
 * a subtracted hole (e.g. a click target that fell on the browser toolbar).
 */

export interface RectShape {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CircleShape {
  type: "circle";
  cx: number;
  cy: number;
  r: number;
}

export interface EllipseShape {
  type: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface PolygonShape {
  type: "polygon";
  points: Point[];
}

/**
 * An arbitrary shape defined by an SVG path `d` string, in ABSOLUTE DESKTOP
 * coordinates. This is the most expressive option — draw any maze / blob /
 * multi-subpath area in an editor and paste the `d` here. Curves are flattened
 * to polylines for the point-in-shape test; the raw `d` is used verbatim for
 * rendering. Multiple subpaths (M ... M ...) are supported and use even-odd
 * fill semantics (so inner subpaths become holes).
 */
export interface SvgPathShape {
  type: "svgpath";
  d: string;
  /** fill rule for the point test (default "evenodd"). */
  fillRule?: "evenodd" | "nonzero";
}

export interface UnionShape {
  type: "union";
  shapes: RegionShape[];
}

export interface SubtractShape {
  type: "subtract";
  /** The area to include. */
  base: RegionShape;
  /** Areas to punch out of `base` (e.g. toolbars, tabs, ad slots). */
  holes: RegionShape[];
}

export type RegionShape =
  | RectShape
  | CircleShape
  | EllipseShape
  | PolygonShape
  | SvgPathShape
  | UnionShape
  | SubtractShape;

/** A stored named region is EITHER a legacy Region rect OR a RegionShape. */
export type StoredRegion = Region | RegionShape;

/** Type guard: does this stored value carry a shape (vs a legacy rect)? */
export function isRegionShape(v: any): v is RegionShape {
  return !!v && typeof v === "object" && typeof v.type === "string";
}

/** Coerce a legacy {x,y,width,height} rect into a RectShape. */
export function toShape(v: StoredRegion): RegionShape {
  if (isRegionShape(v)) return v;
  return { type: "rect", x: v.x, y: v.y, width: v.width, height: v.height };
}

/** Is desktop point `p` inside `shape`? */
export function pointInShape(shape: RegionShape, p: Point): boolean {
  switch (shape.type) {
    case "rect":
      return (
        p.x >= shape.x &&
        p.x <= shape.x + shape.width &&
        p.y >= shape.y &&
        p.y <= shape.y + shape.height
      );
    case "circle": {
      const dx = p.x - shape.cx;
      const dy = p.y - shape.cy;
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    case "ellipse": {
      if (shape.rx <= 0 || shape.ry <= 0) return false;
      const nx = (p.x - shape.cx) / shape.rx;
      const ny = (p.y - shape.cy) / shape.ry;
      return nx * nx + ny * ny <= 1;
    }
    case "polygon":
      return pointInPolygon(shape.points, p);
    case "svgpath": {
      const subs = flattenSvgPath(shape.d);
      return pointInSubpaths(subs, p, shape.fillRule ?? "evenodd");
    }
    case "union":
      return shape.shapes.some((s) => pointInShape(s, p));
    case "subtract":
      return (
        pointInShape(shape.base, p) &&
        !shape.holes.some((h) => pointInShape(h, p))
      );
  }
}

/** Standard ray-cast even-odd point-in-polygon test. */
function pointInPolygon(pts: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Even-odd test across multiple subpaths: inside if an odd number contain p. */
function pointInSubpaths(
  subs: Point[][],
  p: Point,
  rule: "evenodd" | "nonzero"
): boolean {
  if (rule === "nonzero") {
    // Winding-number style: treat union of subpaths (good enough for our use).
    return subs.some((s) => pointInPolygon(s, p));
  }
  let count = 0;
  for (const s of subs) if (pointInPolygon(s, p)) count++;
  return count % 2 === 1;
}

const _pathCache = new Map<string, Point[][]>();

/**
 * Flatten an SVG path `d` string into one polyline per subpath. Supports
 * M/m L/l H/h V/v Z/z and flattens C/c/S/s/Q/q/T/t Bezier curves and A/a arcs
 * into line segments. Coordinates are absolute-desktop (the same space the
 * caller stores). This is intentionally dependency-free.
 */
export function flattenSvgPath(d: string): Point[][] {
  const cached = _pathCache.get(d);
  if (cached) return cached;
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const subs: Point[][] = [];
  let cur: Point[] = [];
  let cx = 0,
    cy = 0,
    startX = 0,
    startY = 0;
  let px2 = 0,
    py2 = 0; // last control point (for S/T smoothing)
  let i = 0;
  let cmd = "";
  const num = () => parseFloat(tokens[i++]);
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const push = (x: number, y: number) => {
    cur.push({ x, y });
    cx = x;
    cy = y;
  };
  const bezier = (
    p0: Point,
    p1: Point,
    p2: Point,
    p3: Point,
    steps = 16
  ) => {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      const x =
        mt * mt * mt * p0.x +
        3 * mt * mt * t * p1.x +
        3 * mt * t * t * p2.x +
        t * t * t * p3.x;
      const y =
        mt * mt * mt * p0.y +
        3 * mt * mt * t * p1.y +
        3 * mt * t * t * p2.y +
        t * t * t * p3.y;
      push(x, y);
    }
  };
  const quad = (p0: Point, p1: Point, p2: Point, steps = 16) => {
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
      const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
      push(x, y);
    }
  };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? { x: cx, y: cy } : { x: 0, y: 0 };
    switch (cmd.toUpperCase()) {
      case "M": {
        const x = num() + base.x;
        const y = num() + base.y;
        if (cur.length) subs.push(cur);
        cur = [];
        push(x, y);
        startX = cx;
        startY = cy;
        cmd = rel ? "l" : "L"; // subsequent implicit pairs are lineto
        break;
      }
      case "L": {
        push(num() + base.x, num() + base.y);
        break;
      }
      case "H": {
        push(num() + (rel ? cx : 0), cy);
        break;
      }
      case "V": {
        push(cx, num() + (rel ? cy : 0));
        break;
      }
      case "C": {
        const p0 = { x: cx, y: cy };
        const p1 = { x: num() + base.x, y: num() + base.y };
        const p2 = { x: num() + base.x, y: num() + base.y };
        const p3 = { x: num() + base.x, y: num() + base.y };
        bezier(p0, p1, p2, p3);
        px2 = p2.x;
        py2 = p2.y;
        break;
      }
      case "S": {
        const p0 = { x: cx, y: cy };
        const p1 = { x: 2 * cx - px2, y: 2 * cy - py2 };
        const p2 = { x: num() + base.x, y: num() + base.y };
        const p3 = { x: num() + base.x, y: num() + base.y };
        bezier(p0, p1, p2, p3);
        px2 = p2.x;
        py2 = p2.y;
        break;
      }
      case "Q": {
        const p0 = { x: cx, y: cy };
        const p1 = { x: num() + base.x, y: num() + base.y };
        const p2 = { x: num() + base.x, y: num() + base.y };
        quad(p0, p1, p2);
        px2 = p1.x;
        py2 = p1.y;
        break;
      }
      case "T": {
        const p0 = { x: cx, y: cy };
        const p1 = { x: 2 * cx - px2, y: 2 * cy - py2 };
        const p2 = { x: num() + base.x, y: num() + base.y };
        quad(p0, p1, p2);
        px2 = p1.x;
        py2 = p1.y;
        break;
      }
      case "A": {
        // Approximate arc by sampling; consume 7 params, line to endpoint via
        // simple subdivision through the arc.
        const rx = num();
        const ry = num();
        num(); // x-axis-rotation (ignored for approximation)
        num(); // large-arc-flag
        num(); // sweep-flag
        const ex = num() + base.x;
        const ey = num() + base.y;
        // Crude: sample a few points along a straight-ish arc bulge.
        const steps = 12;
        const sx = cx,
          sy = cy;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          push(sx + (ex - sx) * t, sy + (ey - sy) * t);
        }
        void rx;
        void ry;
        break;
      }
      case "Z": {
        push(startX, startY);
        if (cur.length) subs.push(cur);
        cur = [];
        break;
      }
      default:
        i++; // skip unknown token to avoid infinite loop
    }
  }
  if (cur.length) subs.push(cur);
  _pathCache.set(d, subs);
  return subs;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function shapeBox(shape: RegionShape): Box | null {
  switch (shape.type) {
    case "rect":
      return {
        minX: shape.x,
        minY: shape.y,
        maxX: shape.x + shape.width,
        maxY: shape.y + shape.height,
      };
    case "circle":
      return {
        minX: shape.cx - shape.r,
        minY: shape.cy - shape.r,
        maxX: shape.cx + shape.r,
        maxY: shape.cy + shape.r,
      };
    case "ellipse":
      return {
        minX: shape.cx - shape.rx,
        minY: shape.cy - shape.ry,
        maxX: shape.cx + shape.rx,
        maxY: shape.cy + shape.ry,
      };
    case "polygon": {
      if (!shape.points.length) return null;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const pt of shape.points) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      return { minX, minY, maxX, maxY };
    }
    case "svgpath": {
      const subs = flattenSvgPath(shape.d);
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const sub of subs)
        for (const pt of sub) {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
        }
      if (!isFinite(minX)) return null;
      return { minX, minY, maxX, maxY };
    }
    case "union": {
      const boxes = shape.shapes.map(shapeBox).filter(Boolean) as Box[];
      if (!boxes.length) return null;
      return boxes.reduce((a, b) => ({
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
      }));
    }
    case "subtract":
      // Subtracting holes only ever shrinks the covered area; the bounding box
      // is that of the base.
      return shapeBox(shape.base);
  }
}

/** The tight axis-aligned bounding Region of a shape (for crop/screenshot). */
export function shapeBounds(shape: RegionShape): Region {
  const b = shapeBox(shape);
  if (!b) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: Math.round(b.minX),
    y: Math.round(b.minY),
    width: Math.round(b.maxX - b.minX),
    height: Math.round(b.maxY - b.minY),
  };
}

/** Bounding Region for any stored region (legacy rect or shape). */
export function storedBounds(v: StoredRegion): Region {
  return isRegionShape(v) ? shapeBounds(v) : { ...v };
}

/**
 * Build an SVG <path>/<shape> string for a RegionShape, in a coordinate space
 * transformed by `tx`/`ty` (desktop -> image pixel). Used to draw non-rect
 * regions in screenshotAnnotated. Returns the inner geometry element(s) with
 * the given fill/stroke applied.
 */
export function shapeToSvg(
  shape: RegionShape,
  tx: (x: number) => number,
  ty: (y: number) => number,
  style: string
): string {
  switch (shape.type) {
    case "rect": {
      const x = tx(shape.x);
      const y = ty(shape.y);
      const w = tx(shape.x + shape.width) - x;
      const h = ty(shape.y + shape.height) - y;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${style}/>`;
    }
    case "circle": {
      const cx = tx(shape.cx);
      const cy = ty(shape.cy);
      const r = tx(shape.cx + shape.r) - cx;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" ${style}/>`;
    }
    case "ellipse": {
      const cx = tx(shape.cx);
      const cy = ty(shape.cy);
      const rx = tx(shape.cx + shape.rx) - cx;
      const ry = ty(shape.cy + shape.ry) - cy;
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${style}/>`;
    }
    case "polygon": {
      const d = shape.points
        .map((pt, i) => `${i === 0 ? "M" : "L"}${tx(pt.x)},${ty(pt.y)}`)
        .join(" ");
      return `<path d="${d} Z" ${style}/>`;
    }
    case "svgpath": {
      // Re-project each flattened subpath into image space and re-emit as a
      // single path so the drawn overlay matches the point test exactly (and
      // honors any downscale). fill-rule enables holes from inner subpaths.
      const subs = flattenSvgPath(shape.d);
      const d = subs
        .map(
          (sub) =>
            sub
              .map(
                (pt, i) => `${i === 0 ? "M" : "L"}${tx(pt.x)},${ty(pt.y)}`
              )
              .join(" ") + " Z"
        )
        .join(" ");
      const rule = shape.fillRule ?? "evenodd";
      return `<path d="${d}" fill-rule="${rule}" ${style}/>`;
    }
    case "union":
      return shape.shapes.map((s) => shapeToSvg(s, tx, ty, style)).join("");
    case "subtract": {
      // Draw the base filled, then draw the holes with a "cut-out" look (darker
      // translucent overlay) so it's visually clear those areas are excluded.
      const holeStyle =
        'fill="rgba(255,60,60,0.22)" stroke="rgba(255,60,60,0.9)" stroke-width="2" stroke-dasharray="6,4"';
      return (
        shapeToSvg(shape.base, tx, ty, style) +
        shape.holes.map((h) => shapeToSvg(h, tx, ty, holeStyle)).join("")
      );
    }
  }
}
