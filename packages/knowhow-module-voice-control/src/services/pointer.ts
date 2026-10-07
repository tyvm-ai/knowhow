/**
 * Pointer memory, shared by the hint commands and the plain click commands.
 * One instance per session lives on `services.pointer` (formerly the
 * module-level `pointerMemory.ts` state).
 */

import type { Candidate } from "../smartSelector";
import type { Clock } from "./clock";
import { systemClock } from "./clock";

/** Duration a placed pointer stays the target of a plain "click". */
export const PLACED_POINTER_MAX_AGE_MS = 30000;

type Point = { x: number; y: number };

/** What the click-family helpers need from a command context. */
export interface PointerTargetContext {
  gaze?: Point;
  gazeFollow?: { isRunning(): boolean };
  target(): Point | undefined;
}

export interface ClickThatContext extends PointerTargetContext {
  mouse?: {
    clickAt(x: number, y: number, button?: "left" | "right"): Promise<void>;
    doubleClickAt(x: number, y: number): Promise<void>;
    clickHere?(button?: "left" | "right"): Promise<void>;
  };
}

export class PointerMemory {
  /**
   * Where a hint command last put the pointer ("mouse over theo"). A plain
   * "click" shortly afterwards clicks there instead of at the (less precise)
   * gaze point, so "mouse over X" then "click" works.
   */
  private placed: { x: number; y: number; at: number; candidate?: Candidate } | null = null;

  constructor(private readonly clock: Clock = systemClock) {}

  notePlaced(p: Point, candidate?: Candidate): void {
    this.placed = { x: Math.round(p.x), y: Math.round(p.y), at: this.clock.now(), candidate };
  }

  clear(): void {
    this.placed = null;
  }

  /**
   * The recently placed pointer, if placed within `maxAgeMs` and (when a gaze
   * point is given) the gaze is still roughly on it.
   */
  recentPlaced(maxAgeMs = 30000, gaze?: Point | null, maxGazeDist = 450): Point | null {
    const p = this.placed;
    if (!p || this.clock.now() - p.at > maxAgeMs) return null;
    if (gaze && Math.hypot(gaze.x - p.x, gaze.y - p.y) > maxGazeDist) return null;
    return { x: p.x, y: p.y };
  }

  /**
   * The candidate element that was last hovered (via "mouse over <hint>").
   * Used by "click that" and "double click that" to AXPress the element instead
   * of a coordinate click, which is important for Spotify hover-only buttons.
   */
  recentCandidate(maxAgeMs = 30000): Candidate | null {
    const p = this.placed;
    if (!p || !p.candidate || this.clock.now() - p.at > maxAgeMs) return null;
    return p.candidate;
  }

  /**
   * Where a plain "click" should act: the gaze-follow pointer if it's running;
   * else a pointer a hint command placed recently ("mouse over theo") as long as
   * you're still looking near it; else where you were looking.
   */
  clickTarget(ctx: PointerTargetContext): Point | undefined {
    if (ctx.gazeFollow?.isRunning()) return ctx.target();
    return this.recentPlaced(PLACED_POINTER_MAX_AGE_MS, ctx.gaze ?? null) ?? ctx.target();
  }

  /**
   * Where a plain "double click" should act. After "mouse over X" the pointer
   * is already on X and your eyes have usually moved on (to read, or to look at
   * the result), so — unlike a plain "click" — a recently placed pointer always
   * wins, with no gaze-distance gate and even while gaze-follow is on. Only
   * without a recent placement does it fall back to the gaze point.
   */
  doubleClickTarget(ctx: PointerTargetContext): Point | undefined {
    return this.recentPlaced(PLACED_POINTER_MAX_AGE_MS) ?? this.clickTarget(ctx);
  }

  /**
   * "click that" / "click it": click whatever is under the pointer right now.
   * Never re-targets to gaze — after "mouse over drive" the pointer is already on
   * the thing you mean, and your eyes have usually moved on. Prefers a click in
   * place; falls back to the pointer a hint just placed (no gaze gating), and only
   * as a last resort to the gaze point.
   */
  async clickThat(ctx: ClickThatContext, kind: "left" | "right" | "double" = "left"): Promise<void> {
    const mouse = ctx.mouse;
    if (!mouse) return;
    if (kind !== "double" && mouse.clickHere) {
      await mouse.clickHere(kind);
      return;
    }
    const pos = this.recentPlaced(PLACED_POINTER_MAX_AGE_MS) ?? this.clickTarget(ctx);
    if (!pos) return;
    if (kind === "double") await mouse.doubleClickAt(pos.x, pos.y);
    else await mouse.clickAt(pos.x, pos.y, kind);
  }
}
