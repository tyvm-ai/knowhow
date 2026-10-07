/**
 * Pointer memory, shared by the hint commands and the plain click commands.
 */

import type { Candidate } from "./smartSelector";

// ─── Pointer memory ───────────────────────────────────────────────────────────

/**
 * Where a hint command last put the pointer ("mouse over theo"). A plain
 * "click" shortly afterwards clicks there instead of at the (less precise)
 * gaze point, so "mouse over X" then "click" works.
 */
let _placedPointer: { x: number; y: number; at: number; candidate?: Candidate } | null = null;

export function notePointerPlaced(p: { x: number; y: number }, candidate?: Candidate): void {
  _placedPointer = { x: Math.round(p.x), y: Math.round(p.y), at: Date.now(), candidate };
}

export function clearPlacedPointer(): void {
  _placedPointer = null;
}

/**
 * The recently placed pointer, if placed within `maxAgeMs` and (when a gaze
 * point is given) the gaze is still roughly on it.
 */
export function recentPlacedPointer(
  maxAgeMs = 30000,
  gaze?: { x: number; y: number } | null,
  maxGazeDist = 450,
): { x: number; y: number } | null {
  const p = _placedPointer;
  if (!p || Date.now() - p.at > maxAgeMs) return null;
  if (gaze && Math.hypot(gaze.x - p.x, gaze.y - p.y) > maxGazeDist) return null;
  return { x: p.x, y: p.y };
}

/**
 * The candidate element that was last hovered (via "mouse over <hint>").
 * Used by "click that" and "double click that" to AXPress the element instead
 * of a coordinate click, which is important for Spotify hover-only buttons.
 */
export function recentPlacedCandidate(maxAgeMs = 30000): Candidate | null {
  const p = _placedPointer;
  if (!p || !p.candidate || Date.now() - p.at > maxAgeMs) return null;
  return p.candidate;
}

/** Duration a placed pointer stays the target of a plain "click". */
export const PLACED_POINTER_MAX_AGE_MS = 30000;

/**
 * Where a plain "click" should act: the gaze-follow pointer if it's running;
 * else a pointer a hint command placed recently ("mouse over theo") as long as
 * you're still looking near it; else where you were looking.
 */
export function clickTarget(ctx: {
  gaze?: { x: number; y: number };
  gazeFollow?: { isRunning(): boolean };
  target(): { x: number; y: number } | undefined;
}): { x: number; y: number } | undefined {
  if (ctx.gazeFollow?.isRunning()) return ctx.target();
  return recentPlacedPointer(PLACED_POINTER_MAX_AGE_MS, ctx.gaze ?? null) ?? ctx.target();
}

/**
 * Where a plain "double click" should act. After "mouse over X" the pointer
 * is already on X and your eyes have usually moved on (to read, or to look at
 * the result), so — unlike a plain "click" — a recently placed pointer always
 * wins, with no gaze-distance gate and even while gaze-follow is on. Only
 * without a recent placement does it fall back to the gaze point.
 */
export function doubleClickTarget(ctx: {
  gaze?: { x: number; y: number };
  gazeFollow?: { isRunning(): boolean };
  target(): { x: number; y: number } | undefined;
}): { x: number; y: number } | undefined {
  return recentPlacedPointer(PLACED_POINTER_MAX_AGE_MS) ?? clickTarget(ctx);
}

/**
 * "click that" / "click it": click whatever is under the pointer right now.
 * Never re-targets to gaze — after "mouse over drive" the pointer is already on
 * the thing you mean, and your eyes have usually moved on. Prefers a click in
 * place; falls back to the pointer a hint just placed (no gaze gating), and only
 * as a last resort to the gaze point.
 */
export async function clickThat(
  ctx: {
    gaze?: { x: number; y: number };
    gazeFollow?: { isRunning(): boolean };
    target(): { x: number; y: number } | undefined;
    mouse?: {
      clickAt(x: number, y: number, button?: "left" | "right"): Promise<void>;
      doubleClickAt(x: number, y: number): Promise<void>;
      clickHere?(button?: "left" | "right"): Promise<void>;
    };
  },
  kind: "left" | "right" | "double" = "left",
): Promise<void> {
  const mouse = ctx.mouse;
  if (!mouse) return;
  if (kind !== "double" && mouse.clickHere) {
    await mouse.clickHere(kind);
    return;
  }
  const pos = recentPlacedPointer(PLACED_POINTER_MAX_AGE_MS) ?? clickTarget(ctx);
  if (!pos) return;
  if (kind === "double") await mouse.doubleClickAt(pos.x, pos.y);
  else await mouse.clickAt(pos.x, pos.y, kind);
}
