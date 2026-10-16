/**
 * Geometry helpers that complement the core snapRect/resolveMonitor in types.ts.
 * These are additive — no duplicates.
 */

import type { MonitorInfo, Rect } from "./types";

/**
 * Sort monitors left-to-right (by x origin of bounds) and assign 1-based index.
 * Returns a new array; does not mutate input.
 */
export function sortAndIndexMonitors(raw: MonitorInfo[]): MonitorInfo[] {
  return [...raw]
    .sort((a, b) => a.bounds.x - b.bounds.x)
    .map((m, i) => ({ ...m, index: i + 1 }));
}

/**
 * Find which monitor a given point falls in.
 * Returns the containing monitor, or the nearest one if the point is in a gap.
 */
export function monitorForPoint(
  point: { x: number; y: number },
  monitors: MonitorInfo[],
): MonitorInfo | undefined {
  if (!monitors.length) return undefined;
  const containing = monitors.find(
    (m) =>
      point.x >= m.bounds.x &&
      point.x < m.bounds.x + m.bounds.width &&
      point.y >= m.bounds.y &&
      point.y < m.bounds.y + m.bounds.height,
  );
  if (containing) return containing;
  // Nearest by center distance
  return [...monitors].sort((a, b) => {
    const cx = (r: Rect) => r.x + r.width / 2;
    const cy = (r: Rect) => r.y + r.height / 2;
    const da = Math.hypot(point.x - cx(a.bounds), point.y - cy(a.bounds));
    const db = Math.hypot(point.x - cx(b.bounds), point.y - cy(b.bounds));
    return da - db;
  })[0];
}
