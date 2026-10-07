import { TimerHandle } from "../services";
import { fetchLiveGaze, getErrorRadius, getFrontmostAppName, getWindowKey } from "./context";
import { HINT_DENSITY } from "./density";
import { density } from "./packState";
import { stabilizeLabels } from "./labels";
import { showHintOverlay } from "./overlay";
import { HintsCtx, HintsState } from "./packState";
import { collectCandidates } from "./perception/collect";

// ─── Hint mode: labels follow your gaze ───────────────────────────────────────

/** Gaze must move this far from the last scan centre to trigger a rescan. */
const HINT_MODE_MOVE_PX = 260;
/** …and settle (stay within HINT_MODE_DWELL_PX) for this long. */
const HINT_MODE_DWELL_MS = 350;
const HINT_MODE_DWELL_PX = 160;
/** Rescan in place this often anyway, so scrolled/changed pages refresh. */
const HINT_MODE_IDLE_REFRESH_MS = 5000;
const HINT_MODE_POLL_MS = 150;
/** While hint mode is on, labels and their numbers stay valid until it's turned off. */
const HINT_MODE_TTL_MS = Number.POSITIVE_INFINITY;

export class HintModeController {
  private timer?: TimerHandle;
  private running = false;
  private scanning = false;
  private anchor?: { x: number; y: number };
  private lastScanAt = 0;
  private dwell?: { x: number; y: number; since: number };
  private forceAt = 0;

  constructor(private readonly ctx: HintsCtx) {}

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.forceAt = this.ctx.services.clock.now();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) this.ctx.services.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.ctx.state.selector.clearHintState();
    await this.ctx.services.computer?.clearOverlay?.().catch(() => undefined);
  }

  /** Rescan soon (e.g. after a click changed the page). */
  refreshSoon(delayMs = 700): void {
    if (this.running) this.forceAt = this.ctx.services.clock.now() + delayMs;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = this.ctx.services.clock.setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const gaze = await fetchLiveGaze(this.ctx);
      const now = this.ctx.services.clock.now();
      if (gaze && !this.scanning) {
        if (!this.dwell || Math.hypot(gaze.x - this.dwell.x, gaze.y - this.dwell.y) > HINT_MODE_DWELL_PX) {
          this.dwell = { ...gaze, since: now };
        }
        const settled = now - this.dwell.since >= HINT_MODE_DWELL_MS;
        const moved =
          !this.anchor || Math.hypot(this.dwell.x - this.anchor.x, this.dwell.y - this.anchor.y) > HINT_MODE_MOVE_PX;
        const forced = this.forceAt > 0 && now >= this.forceAt;
        const idle = now - this.lastScanAt > HINT_MODE_IDLE_REFRESH_MS;
        if ((settled && (moved || idle)) || forced) {
          this.forceAt = 0;
          await this.scan(settled ? { x: this.dwell.x, y: this.dwell.y } : gaze);
        }
      }
    } catch (e) {
      this.ctx.log(`[hints] hint mode error: ${e}`);
    } finally {
      this.schedule(HINT_MODE_POLL_MS);
    }
  }

  private async scan(at: { x: number; y: number }): Promise<void> {
    const adapter = this.ctx.services.computer ?? null;
    if (!adapter) return;
    this.scanning = true;
    try {
      const cfg = HINT_DENSITY[density(this.ctx.state, this.ctx.config.density) === "all" ? "normal" : density(this.ctx.state, this.ctx.config.density)];
      const candidates = await collectCandidates(
        this.ctx.state.selector,
        adapter,
        at,
        getErrorRadius(),
        getWindowKey(this.ctx),
        {
          appName: await getFrontmostAppName(this.ctx),
          adapters: this.ctx.services.adapters,
          source: this.ctx.config.source,
          scanFactor: cfg.scanFactor,
          maxCandidates: Math.max(20, cfg.labels),
          log: () => undefined, // quiet: this runs every few seconds
        }
      );
      if (!this.running) return;
      this.anchor = at;
      this.lastScanAt = this.ctx.services.clock.now();
      if (!candidates.length) return;
      // Keep numbers stable across refreshes and only keep labels that are drawn.
      const shown = stabilizeLabels(
        this.ctx.state.selector.getHintState()?.candidates,
        candidates.slice(0, cfg.labels)
      );
      this.ctx.state.selector.setHintState({
        candidates: shown,
        timestamp: this.ctx.services.clock.now(),
        selectedIndex: -1,
        ttlMs: HINT_MODE_TTL_MS,
      });
      await showHintOverlay(this.ctx.state.selector, adapter, shown, HINT_MODE_TTL_MS, cfg.labels);
    } finally {
      this.scanning = false;
    }
  }
}

export function isHintModeRunning(state: HintsState): boolean {
  return !!state.hintMode?.isRunning();
}

export async function stopHintMode(state: HintsState): Promise<void> {
  const m = state.hintMode;
  state.hintMode = null;
  await m?.stop();
}
