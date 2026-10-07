/**
 * TargetResolver — ONE place that decides where an action lands.
 *
 * Inputs that can name a point: a hinted element, the pointer a "mouse over X"
 * placed, the gaze-follow cursor, and the gaze point itself. Which of them wins
 * is a per-action TargetPolicy in the single `POLICIES` table below (these
 * encode the rules the click-family commands had accumulated):
 *
 * - click / rightClick: gaze-follow (when running) beats everything; otherwise a
 *   pointer placed in the last 30 s — but only while your gaze is still within
 *   450 px of it; otherwise the gaze point.
 * - doubleClick (and every "… that / it / here / there" form, "click that"):
 *   a pointer placed in the last 30 s ALWAYS wins — no gaze check, even while
 *   gaze-follow is on, because after "mouse over X" your eyes have moved on to
 *   read the result. Only without a recent placement does it fall back to
 *   gaze-follow, then the gaze point.
 * - type / scroll: act where you are looking (gaze-follow position if running).
 *   A placed pointer is not consulted.
 */

import type { HintRef } from "../grammar/slots";
import type { AXElement, Candidate } from "../smartSelector";
import { PLACED_POINTER_MAX_AGE_MS } from "../services/pointer";
import type { PointerMemory } from "../services/pointer";

export type TargetSource = "hint" | "pointer" | "gaze" | "follow" | "element";
export type TargetAction = "click" | "doubleClick" | "rightClick" | "type" | "scroll";
export type AxElementLike = AXElement;

export interface Target {
  point: { x: number; y: number };
  element?: AxElementLike;
  source: TargetSource;
  /** Age of the pointer placement (source "pointer" only). */
  ageMs?: number;
  /** App the target lives in, when known (the app that was in front when the pointer was placed). */
  app?: string;
}

export interface TargetPolicy {
  /** A pointer placed by "mouse over X" counts as the target for this long (0 = pointer is never consulted). */
  maxPointerAgeMs: number;
  /** The placed pointer only counts while the gaze is within `gazeAgreementPx` of it. */
  requireGazeAgreement: boolean;
  gazeAgreementPx?: number;
  /** A running gaze-follow cursor can be the target. */
  allowFollow: boolean;
  /** …and when it runs it beats a placed pointer (otherwise the pointer is checked first). */
  followOverridesPointer: boolean;
}

export const GAZE_AGREEMENT_PX = 450;

export const POLICIES: Record<TargetAction, TargetPolicy> = {
  click: {
    maxPointerAgeMs: PLACED_POINTER_MAX_AGE_MS,
    requireGazeAgreement: true,
    gazeAgreementPx: GAZE_AGREEMENT_PX,
    allowFollow: true,
    followOverridesPointer: true,
  },
  rightClick: {
    maxPointerAgeMs: PLACED_POINTER_MAX_AGE_MS,
    requireGazeAgreement: true,
    gazeAgreementPx: GAZE_AGREEMENT_PX,
    allowFollow: true,
    followOverridesPointer: true,
  },
  doubleClick: {
    maxPointerAgeMs: PLACED_POINTER_MAX_AGE_MS,
    requireGazeAgreement: false,
    allowFollow: true,
    followOverridesPointer: false,
  },
  type: {
    maxPointerAgeMs: 0,
    requireGazeAgreement: false,
    allowFollow: true,
    followOverridesPointer: true,
  },
  scroll: {
    maxPointerAgeMs: 0,
    requireGazeAgreement: false,
    allowFollow: true,
    followOverridesPointer: true,
  },
};

/** "that" forms ("click that", "double click that") use the double-click rules whatever the action. */
export const THAT_POLICY: TargetPolicy = POLICIES.doubleClick;

/** What the resolver needs from a command context. */
export interface TargetContext {
  gaze?: { x: number; y: number };
  gazeFollow?: { isRunning(): boolean };
  target(): { x: number; y: number } | undefined;
}

export interface ResolveHints {
  /** A spoken hint reference ("save", "button 2"), looked up through `deps.lookupRef`. */
  ref?: HintRef;
  /** An element already chosen (a hinted candidate). */
  element?: AxElementLike;
  /** "… that / it / here / there": act on what "mouse over" last pointed at. */
  that?: boolean;
}

export interface TargetResolverDeps {
  pointer: PointerMemory;
  /** Resolve a hint ref against the labels on screen. */
  lookupRef?: (ref: HintRef) => Candidate | undefined;
}

export function centerOf(el: AxElementLike): { x: number; y: number } | undefined {
  const b = el.bounds;
  return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : undefined;
}

export class TargetResolver {
  constructor(private readonly deps: TargetResolverDeps) {}

  /** The policy used for an action (`that` forms use the double-click rules). */
  policyFor(action: TargetAction, hints?: ResolveHints): TargetPolicy {
    return hints?.that ? THAT_POLICY : POLICIES[action];
  }

  async resolve(ctx: TargetContext, action: TargetAction, hints: ResolveHints = {}): Promise<Target | undefined> {
    // 1. Something explicit: a chosen element, or a hint ref the labels resolve.
    const explicit = hints.element ?? (hints.ref ? this.deps.lookupRef?.(hints.ref)?.element : undefined);
    if (explicit) {
      const point = centerOf(explicit);
      if (point) return { point, element: explicit, source: hints.element ? "element" : "hint" };
    }

    const policy = this.policyFor(action, hints);
    const followRunning = policy.allowFollow && !!ctx.gazeFollow?.isRunning();
    const follow = (): Target | undefined => {
      const point = ctx.target();
      return point ? { point, source: "follow" } : undefined;
    };

    // 2. Gaze-follow, when its rules put it ahead of a placed pointer.
    if (followRunning && policy.followOverridesPointer) {
      const t = follow();
      if (t) return t;
    }

    // 3. The pointer a hint command placed.
    if (policy.maxPointerAgeMs > 0) {
      const placed = this.deps.pointer.peekPlaced(
        policy.maxPointerAgeMs,
        policy.requireGazeAgreement ? ctx.gaze ?? null : null,
        policy.gazeAgreementPx
      );
      if (placed) {
        return {
          point: { x: placed.x, y: placed.y },
          element: hints.that ? placed.candidate?.element : undefined,
          source: "pointer",
          ageMs: placed.ageMs,
          app: placed.app,
        };
      }
    }

    // 4. Gaze-follow as a fallback, then the gaze point.
    if (followRunning) {
      const t = follow();
      if (t) return t;
    }
    const point = ctx.target();
    return point ? { point, source: "gaze" } : undefined;
  }
}
