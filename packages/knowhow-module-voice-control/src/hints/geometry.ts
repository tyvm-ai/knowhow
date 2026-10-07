import type { Rect } from "./types";

/** Pure rectangle helpers shared by perception, ranking and labels. */

export function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function round(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

export function rectOverlapFrac(a: Rect, b: Rect): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r <= x || btm <= y) return 0;
  const inter = (r - x) * (btm - y);
  return inter / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

export function centerInside(a: Rect, b: Rect): boolean {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}
