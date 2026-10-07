import { GAZE_ERROR_RADIUS, GAZE_TIMEOUT, GazeClient } from "../gaze";
import { TimerHandle } from "../services";
import { Clock, systemClock } from "../services/clock";
import { getWindowKey } from "./context";
import { collectCandidates } from "./perception/collect";
import { round } from "./geometry";
import { SelectorState } from "./selectorState";
import { ComputerUseAdapter, HintSource } from "./types";

// ─── Smart mouse controller ───────────────────────────────────────────────────

export interface SmartMouseOptions {
  pollHz?: number;
  alpha?: number;
  deadZone?: number;
  snapDeadZone?: number; // hysteresis: don't switch candidates unless distance > this
  hubUrl?: string;
  errorRadius?: { x: number; y: number };
  /** Injected for tests / session shutdown accounting (default: real timers). */
  clock?: Clock;
  /** Hint/AX-cache state shared with the owning pack (default: private). */
  selector?: SelectorState;
  /** Candidate source, read on every poll (the hints pack passes `() => ctx.config.source`). */
  source?: () => HintSource;
}

export class SmartMouseController {
  private timer?: TimerHandle;
  private readonly clock: Clock;
  private readonly selector: SelectorState;
  private smoothX = 0;
  private smoothY = 0;
  private hasFirst = false;
  private readonly alpha: number;
  private readonly deadZone: number;
  private readonly snapDeadZone: number;
  private readonly gaze: GazeClient;
  private readonly errorRadius: { x: number; y: number };
  private lastTargetId: string | undefined;
  private busy = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly adapter: ComputerUseAdapter,
    private readonly getWindowKey: () => string,
    private readonly options: SmartMouseOptions = {},
  ) {
    this.alpha = options.alpha ?? 0.3;
    this.deadZone = options.deadZone ?? 4;
    this.snapDeadZone = options.snapDeadZone ?? 30;
    this.gaze = new GazeClient({ hubUrl: options.hubUrl });
    this.clock = options.clock ?? systemClock;
    this.selector = options.selector ?? new SelectorState(this.clock);
    this.errorRadius = options.errorRadius ?? { ...GAZE_ERROR_RADIUS };
  }

  isRunning(): boolean {
    return !!this.timer;
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = Math.round(1000 / (this.options.pollHz ?? 30));
    this.timer = this.clock.setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.hasFirst = false;
    this.lastTargetId = undefined;
  }

  private async tick(): Promise<void> {
    // Never overlap ticks: a screenshot scan can take longer than the poll interval.
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tickInner();
    } finally {
      this.busy = false;
    }
  }

  private async tickInner(): Promise<void> {
    try {
      const sample = await this.gaze.current({ timeoutMs: GAZE_TIMEOUT.tick });
      if (!sample) return;

      if (!this.hasFirst) {
        this.smoothX = sample.x;
        this.smoothY = sample.y;
        this.hasFirst = true;
      } else {
        this.smoothX = this.alpha * sample.x + (1 - this.alpha) * this.smoothX;
        this.smoothY = this.alpha * sample.y + (1 - this.alpha) * this.smoothY;
      }

      // Get candidates near gaze
      const candidates = await collectCandidates(
        this.selector,
        this.adapter,
        { x: this.smoothX, y: this.smoothY },
        this.errorRadius,
        this.getWindowKey(),
        // Scan the whole window once and reuse it for a few seconds so the
        // magnetic cursor stays responsive when it relies on screenshots.
        { visualScan: "window", visualTtlMs: 3000, log: () => undefined, source: this.options.source?.() },
      );

      if (!candidates.length) {
        // Fall back to raw gaze position
        const dx = Math.abs(this.smoothX - this.lastX);
        const dy = Math.abs(this.smoothY - this.lastY);
        if (dx >= this.deadZone || dy >= this.deadZone) {
          this.lastX = Math.round(this.smoothX);
          this.lastY = Math.round(this.smoothY);
          await this.adapter.moveMouse({ x: this.lastX, y: this.lastY });
        }
        return;
      }

      const best = candidates[0];
      const bounds = best.element.bounds;
      if (!bounds) return;
      const targetX = Math.round(bounds.x + bounds.width / 2);
      const targetY = Math.round(bounds.y + bounds.height / 2);

      // Hysteresis: only switch candidate if the new one is significantly different
      if (
        this.lastTargetId !== undefined &&
        best.element.id !== this.lastTargetId
      ) {
        const dist = Math.sqrt(
          (targetX - this.lastX) ** 2 + (targetY - this.lastY) ** 2,
        );
        if (dist < this.snapDeadZone) return;
      }

      this.lastTargetId = best.element.id;
      const dx = Math.abs(targetX - this.lastX);
      const dy = Math.abs(targetY - this.lastY);
      if (dx < this.deadZone && dy < this.deadZone) return;

      this.lastX = targetX;
      this.lastY = targetY;
      await this.adapter.moveMouse({ x: targetX, y: targetY });
    } catch {
      // ignore transient errors
    }
  }

  currentPosition(): { x: number; y: number } | undefined {
    if (!this.hasFirst) return undefined;
    return { x: this.lastX, y: this.lastY };
  }
}
