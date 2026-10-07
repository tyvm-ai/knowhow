import { TimerHandle } from "../services";
import { Clock, systemClock } from "../services/clock";
import { VisualScanState } from "./perception/visual";
import { AXElement, Candidate } from "./types";

// ─── Hint state ───────────────────────────────────────────────────────────────

export interface HintState {
  candidates: Candidate[];
  timestamp: number;
  selectedIndex: number; // -1 = none
  ttlMs: number;
}

/**
 * Per-session selector state (what used to be module-level `let`s): the hint
 * state on screen (+ recent history), the AX tree cache and the overlay
 * auto-clear timer. The hints pack owns one in its pack state; the
 * `sdk.ext.hints` extension makes its own.
 */
export class SelectorState {
  hintState: HintState | null = null;
  /** Recent hint states (newest last) — hint mode replaces labels as gaze moves. */
  private readonly hintHistory: HintState[] = [];
  axCache: AXCache | null = null;
  /** Screenshot-scan cache + last timings. */
  readonly visual = new VisualScanState();
  overlayClearTimer: TimerHandle | undefined;

  constructor(readonly clock: Clock = systemClock) {}

  getHintState(): HintState | null {
    if (!this.hintState) return null;
    if (this.clock.now() - this.hintState.timestamp > this.hintState.ttlMs) {
      this.hintState = null;
      return null;
    }
    return this.hintState;
  }

  clearHintState(): void {
    this.hintState = null;
    this.hintHistory.length = 0;
  }

  setHintState(state: HintState): void {
    this.hintState = state;
    this.hintHistory.push(state);
    if (this.hintHistory.length > 8) this.hintHistory.shift();
  }

  /**
   * The hint state that was on screen at time `ts` (speech onset). In hint mode
   * the labels refresh while you talk; "click text 3" must mean the "text 3"
   * you saw when you started speaking, not one drawn a moment later.
   */
  getHintStateAt(ts: number | undefined): HintState | null {
    const current = this.getHintState();
    if (!current || ts === undefined) return current;
    for (let i = this.hintHistory.length - 1; i >= 0; i--) {
      const h = this.hintHistory[i];
      if (h.timestamp <= ts) return this.clock.now() - h.timestamp <= h.ttlMs ? h : null;
    }
    return current;
  }

  invalidateAXCache(): void {
    this.axCache = null;
  }

  /** Cancel the pending overlay auto-clear (session stop). */
  dispose(): void {
    if (this.overlayClearTimer) this.clock.clearTimeout(this.overlayClearTimer);
    this.overlayClearTimer = undefined;
  }
}

// ─── AX cache ─────────────────────────────────────────────────────────────────

interface AXCache {
  elements: AXElement[];
  timestamp: number;
  windowKey: string;
}

export const AX_CACHE_TTL_MS = 500;
