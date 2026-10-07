import { formatList } from "../services/logger";
import { TimerHandle } from "../services";
import { getAdapter, getErrorRadius, getFrontmostAppName, getWindowKey } from "./context";
import { HINT_DENSITY, HINT_OVERLAY_MS, HINT_STATE_TTL_MS, HintDensity } from "./density";
import { density } from "./packState";
import { isHintModeRunning } from "./hintMode";
import { stabilizeLabels } from "./labels";
import { showHintOverlay } from "./overlay";
import { HintsCtx, HintsState } from "./packState";
import { collectCandidates } from "./perception/collect";
import { round } from "./geometry";
import { showHintsNear } from "./show";
import { Candidate } from "./types";

// ─── Map watcher: keep a shown map up to date ─────────────────────────────────

/** Fraction of labelled elements that must change before the map is redrawn. */
const MAP_CHANGE_THRESHOLD = 0.15;
/** …and the change must be seen on this many consecutive scans (debounce flicker). */
const MAP_CHANGE_CONFIRM_SCANS = 2;

/**
 * How different two label sets are, 0 (same) … 1 (nothing in common).
 * Elements match by role + name + roughly the same place (see stabilizeLabels),
 * so a reordering or a few px of AX jitter is not a change; scrolling, opening
 * another email or switching window is.
 */
export function mapChangeFraction(prev: Candidate[], next: Candidate[]): number {
  if (!prev.length && !next.length) return 0;
  if (!prev.length || !next.length) return 1;
  // stabilizeLabels keeps the number of every element it recognises; reuse it.
  const relabelled = stabilizeLabels(prev, next);
  const prevLabels = new Set(prev.map((c) => c.label));
  let kept = 0;
  relabelled.forEach((c, i) => {
    const p = prev.find((x) => x.label === c.label);
    const b = c.element.bounds,
      pb = p?.element.bounds;
    if (!p || !prevLabels.has(c.label) || !b || !pb) return;
    if (p.roleName !== next[i].roleName || (p.displayName ?? "") !== (next[i].displayName ?? "")) return;
    if (Math.abs(b.x - pb.x) > 16 || Math.abs(b.y - pb.y) > 16) return;
    kept++;
  });
  return 1 - kept / Math.max(prev.length, next.length);
}

export interface MapSpec {
  density: HintDensity;
  query?: string[];
  gaze: { x: number; y: number };
}

export class MapWatcher {
  private timer?: TimerHandle;
  private running = false;
  private scanning = false;
  private pendingChanges = 0;
  private forceAt = 0;

  constructor(private readonly ctx: HintsCtx, readonly spec: MapSpec) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.ctx.services.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Rescan soon (after a click, the page probably changed). */
  refreshSoon(delayMs = 900): void {
    if (!this.running) return;
    this.forceAt = this.ctx.services.clock.now() + delayMs;
    if (this.timer) this.ctx.services.clock.clearTimeout(this.timer);
    this.schedule(delayMs);
  }

  private schedule(ms?: number): void {
    const every = this.ctx.config.mapRefreshMs;
    if (!this.running || (ms === undefined && every <= 0)) return;
    if (this.timer) this.ctx.services.clock.clearTimeout(this.timer);
    this.timer = this.ctx.services.clock.setTimeout(() => void this.tick(), ms ?? every);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.scanning) return this.schedule();
    this.scanning = true;
    try {
      const prev = this.ctx.state.selector.getHintState()?.candidates;
      if (!prev) {
        this.stop();
        return;
      } // hidden elsewhere
      const forced = this.forceAt > 0 && this.ctx.services.clock.now() >= this.forceAt;
      const next = await scanMap(this.ctx, this.spec, () => undefined);
      if (!this.running || !next) return;
      const change = mapChangeFraction(prev, next.slice(0, HINT_DENSITY[this.spec.density].labels));
      if (change < MAP_CHANGE_THRESHOLD) {
        this.pendingChanges = 0;
        if (!forced) return;
        if (change === 0) {
          this.forceAt = 0;
          return;
        }
      } else if (!forced && ++this.pendingChanges < MAP_CHANGE_CONFIRM_SCANS) {
        return;
      }
      this.forceAt = 0;
      this.pendingChanges = 0;
      await drawMap(this.ctx, this.spec, next, true);
      this.ctx.log(`[hints] map refreshed (${Math.round(change * 100)}% changed)`);
    } catch (e) {
      this.ctx.log(`[hints] map refresh error: ${e}`);
    } finally {
      this.scanning = false;
      this.schedule();
    }
  }
}

export function stopMapWatch(state: HintsState): void {
  state.mapWatch?.stop();
  state.mapWatch = null;
}

/** Parse the window for `spec`. Returns undefined when there's no adapter. */
export async function scanMap(ctx: HintsCtx, spec: MapSpec, log: (msg: string) => void): Promise<Candidate[] | undefined> {
  const adapter = getAdapter(ctx);
  if (!adapter) return undefined;
  const cfg = HINT_DENSITY[spec.density];
  return collectCandidates(ctx.state.selector, adapter, spec.gaze, getErrorRadius(), getWindowKey(ctx), {
    query: spec.query,
    wholeWindow: cfg.wholeWindow,
    log,
    appName: await getFrontmostAppName(ctx),
    adapters: ctx.services.adapters,
    source: ctx.config.source,
    scanFactor: cfg.scanFactor,
    maxCandidates: Math.max(20, cfg.labels),
    fullParse: !!cfg.full,
  });
}

/** Publish + draw `candidates` as the map. Returns the labelled list. */
export async function drawMap(ctx: HintsCtx, spec: MapSpec, candidates: Candidate[], quiet = false): Promise<Candidate[]> {
  const adapter = getAdapter(ctx);
  const cfg = HINT_DENSITY[spec.density];
  const labelled = publishHints(ctx.state, candidates, cfg.labels, await getFrontmostAppName(ctx));
  if (adapter) await showHintOverlay(ctx.state.selector, adapter, labelled, HINT_OVERLAY_MS, cfg.labels);
  if (!quiet) {
    ctx.log(
      `[hints] Showing ${labelled.length} hint(s) (${
        cfg.full ? "full window" : spec.density
      }; say "more hints" / "fewer hints" to change, "refresh map" to re-parse, "hide map" to remove): ` +
        formatList(labelled.map((c) => (c.displayName ? `${c.label}=${c.displayName}` : c.label)))
    );
  }
  return labelled;
}

/** "refresh map": re-parse now with the same settings as the map on screen. */
export async function refreshMap(ctx: HintsCtx): Promise<void> {
  if (isHintModeRunning(ctx.state)) {
    ctx.state.hintMode?.refreshSoon(0);
    return;
  }
  const spec = ctx.state.mapWatch?.spec;
  if (!spec) {
    await showHintsNear(ctx, false);
    return;
  }
  const candidates = await scanMap(ctx, spec, ctx.log);
  if (!candidates?.length) {
    ctx.log("[hints] refresh map: nothing found");
    return;
  }
  await drawMap(ctx, spec, candidates);
}

/**
 * Make `candidates` the labels on screen: keep only the ones that will be
 * drawn, keep numbers of elements that were already labelled, and record them
 * as the current hint state. Returns the relabelled list to draw.
 */
export function publishHints(
  state: HintsState,
  candidates: Candidate[],
  maxLabels: number,
  frontApp: string | undefined
): Candidate[] {
  const next = candidates.slice(0, maxLabels);
  // Same UI → same numbers: reuse the numbering of the map on screen, or of
  // the last map shown for this app (even after "hide map"), as long as it's
  // recognisably the same page. A different page gets fresh reading-order
  // numbers instead of a patchwork of old ones.
  const app = frontApp ?? "";
  const prev = state.selector.getHintState()?.candidates ?? state.lastMapByApp.get(app);
  const base = prev?.length && mapChangeFraction(prev, next) < MAP_SAME_PAGE_MAX_CHANGE ? prev : undefined;
  const shown = stabilizeLabels(base, next);
  state.selector.setHintState({
    candidates: shown,
    timestamp: state.selector.clock.now(),
    selectedIndex: -1,
    ttlMs: HINT_STATE_TTL_MS,
  });
  state.lastMapByApp.set(app, shown);
  return shown;
}

/** Above this change fraction a map is treated as a different page (fresh numbering). */
const MAP_SAME_PAGE_MAX_CHANGE = 0.5;
