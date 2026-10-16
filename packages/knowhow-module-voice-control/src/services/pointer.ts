/**
 * Pointer memory: where "mouse over X" last put the pointer. Targeting rules
 * (which of pointer / gaze / follow a click uses) live in `targeting/resolver.ts`.
 * One instance per session lives on `services.pointer` (formerly the
 * module-level `pointerMemory.ts` state).
 */

import type { Candidate } from "../hints/types";
import type { Clock } from "./clock";
import { systemClock } from "./clock";

/** Duration a placed pointer stays the target of a plain "click". */
export const PLACED_POINTER_MAX_AGE_MS = 30000;

type Point = { x: number; y: number };

/** A remembered placement, as returned by `peekPlaced`. */
export interface PlacedPointer extends Point {
  ageMs: number;
  candidate?: Candidate;
  /** Front app when the pointer was placed (if the placing command knew it). */
  app?: string;
}

export class PointerMemory {
  /**
   * Where a hint command last put the pointer ("mouse over theo"). A plain
   * "click" shortly afterwards clicks there instead of at the (less precise)
   * gaze point, so "mouse over X" then "click" works.
   */
  private placed: { x: number; y: number; at: number; candidate?: Candidate; app?: string } | null = null;

  constructor(private readonly clock: Clock = systemClock) {}

  notePlaced(p: Point, candidate?: Candidate, app?: string): void {
    this.placed = { x: Math.round(p.x), y: Math.round(p.y), at: this.clock.now(), candidate, app };
  }

  clear(): void {
    this.placed = null;
  }

  /**
   * The recently placed pointer, if placed within `maxAgeMs` and (when a gaze
   * point is given) the gaze is still roughly on it.
   */
  recentPlaced(maxAgeMs = 30000, gaze?: Point | null, maxGazeDist = 450): Point | null {
    const p = this.peekPlaced(maxAgeMs, gaze, maxGazeDist);
    return p ? { x: p.x, y: p.y } : null;
  }

  /** Like `recentPlaced`, but with the age, remembered element and app (what the TargetResolver needs). */
  peekPlaced(maxAgeMs = 30000, gaze?: Point | null, maxGazeDist = 450): PlacedPointer | null {
    const p = this.placed;
    if (!p) return null;
    const ageMs = this.clock.now() - p.at;
    if (ageMs > maxAgeMs) return null;
    if (gaze && Math.hypot(gaze.x - p.x, gaze.y - p.y) > maxGazeDist) return null;
    return { x: p.x, y: p.y, ageMs, candidate: p.candidate, app: p.app };
  }

  /**
   * The candidate element that was last hovered (via "mouse over <hint>").
   * Used by "click that" and "double click that" to AXPress the element instead
   * of a coordinate click, which matters for hover-only buttons (an app adapter decides what to press).
   */
  recentCandidate(maxAgeMs = 30000): Candidate | null {
    const p = this.placed;
    if (!p || !p.candidate || this.clock.now() - p.at > maxAgeMs) return null;
    return p.candidate;
  }
}
