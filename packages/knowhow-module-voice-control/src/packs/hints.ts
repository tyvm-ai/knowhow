/**
 * Hints pack — gaze + accessibility smart element selection.
 *
 * All hint commands use grammar patterns with the `hint` slot type so that:
 *   - "select input 2" → focus input #2 (not select-all + repeat=2)
 *   - "click save" → click element named "save"
 *   - "type in email hello" → focus field "email", type "hello"
 *   - "click the button below thank you" → NO MATCH (strict hint slot)
 *
 * The `hint` slot (registered in grammar/slots.ts) accepts:
 *   - role [number]: "button", "input 2", "link three"
 *   - free name (≤3 non-filler tokens): "save", "email address"
 * It rejects filler words ("the", "below", "thank", etc.) so whisper
 * hallucinations don't accidentally trigger clicks.
 *
 * Hint commands are NOT repeatable (no trailing number → repeat).
 */

import {
  parseHintRef,
  resolveHintRef,
  rankCandidates,
  collectCandidates,
  isAmbiguous,
  showHintOverlay,
  buildHintOverlayPrimitives,
  activateElement,
  HintState,
  Candidate,
  ComputerUseAdapter,
  postGazeCorrection,
  SelectorState,
  SmartMouseController,
  detectChromeAXStatus,
  HINT_DENSITY,
  HintDensity,
  stabilizeLabels,
} from "../smartSelector";
import { HintRef } from "../grammar/slots";
import { convertDictation } from "../grammar/dictation";
import { GAZE_ERROR_RADIUS, GAZE_TIMEOUT } from "../gaze";
import { centerOf } from "../targeting/resolver";
import { defineVoicePack } from "./define";
import type { PackCommandContext } from "./define";
import type { TimerHandle, VoiceServices } from "../services";

// ─── Pack state ───────────────────────────────────────────────────────────────

/** Per-session hints state (was module-level `let`s in this file and in smartSelector). */
export interface HintsState {
  /** Hint labels on screen, AX cache and overlay timer. */
  selector: SelectorState;
  /** Sticky density chosen with "more hints" / "fewer hints"; undefined = KNOWHOW_HINT_DENSITY or "all" (read per command). */
  density: HintDensity | undefined;
  smartMouse: SmartMouseController | null;
  hintMode: HintModeController | null;
  mapWatch: MapWatcher | null;
  /** Last map shown per app, so re-showing the same UI gives the same numbers. */
  lastMapByApp: Map<string, Candidate[]>;
  /** Stop the smart-mouse controller ("stop mouse" in other packs reaches this through `services.packs.peek("hints")`). */
  stopSmartMouse(): void;
}

export function createHintsState(services: Pick<VoiceServices, "clock">): HintsState {
  const state: HintsState = {
    selector: new SelectorState(services.clock),
    density: undefined,
    smartMouse: null,
    hintMode: null,
    mapWatch: null,
    lastMapByApp: new Map(),
    stopSmartMouse: () => {
      if (state.smartMouse?.isRunning()) state.smartMouse.stop();
      state.smartMouse = null;
    },
  };
  return state;
}

type HintsCtx = PackCommandContext<HintsState>;

// ─── Frontmost app name ───────────────────────────────────────────────────────

/** Short-TTL cache (ms): scan + publish ask back to back; the map watcher asks every few seconds. */
const FRONT_APP_MAX_AGE_MS = 1000;

async function getFrontmostAppName(ctx: HintsCtx): Promise<string | undefined> {
  try {
    return await ctx.services.platform.frontmostApp({ maxAgeMs: FRONT_APP_MAX_AGE_MS, maxWaitMs: 2000 });
  } catch {
    return undefined;
  }
}

// ─── Resolve computer-use adapter from context ────────────────────────────────

function getAdapter(ctx: HintsCtx): ComputerUseAdapter | null {
  return ctx.services.computer ?? null;
}

function getWindowKey(ctx: Pick<HintsCtx, "target">): string {
  const t = ctx.target?.();
  return t ? `${Math.round(t.x / 100)}_${Math.round(t.y / 100)}` : "default";
}

function getErrorRadius(): { x: number; y: number } {
  return { ...GAZE_ERROR_RADIUS };
}

// ─── Hint density ─────────────────────────────────────────────────────────────

const DENSITY_ORDER: HintDensity[] = ["few", "normal", "more", "all"];
// Hints stay up until "hide hints" / "hide map" (no timeout). A new "hints" /
// "map" redraws them. Labels stay on screen exactly as long as their numbers
// are valid, so a visible "text 11" always means the element it is drawn on.
const HINT_STATE_TTL_MS = Number.POSITIVE_INFINITY;
const HINT_OVERLAY_MS = HINT_STATE_TTL_MS;

function initialDensity(): HintDensity {
  const env = process.env.KNOWHOW_HINT_DENSITY as HintDensity | undefined;
  // Default: full parse of the front window, so every email / album / button
  // on screen has a number. "fewer hints" steps back to gaze-centred labels.
  return env && env in HINT_DENSITY ? env : "all";
}

/** Sticky density for "hints": "fewer hints" / "more hints" change it. Read when a command runs. */
export function density(state: HintsState): HintDensity {
  return state.density ?? initialDensity();
}

function stepDensity(state: HintsState, dir: 1 | -1): HintDensity {
  const i = DENSITY_ORDER.indexOf(density(state));
  const next = DENSITY_ORDER[Math.max(0, Math.min(DENSITY_ORDER.length - 1, i + dir))];
  // "more hints" past "more" reaches the full-window parse ("all").
  state.density = next;
  return next;
}

// ─── Gaze source ──────────────────────────────────────────────────────────────

/**
 * Where to look for hints: the gaze at speech onset, else the gaze-follow
 * position, else the live gaze from the eye-tracking hub, else the mouse.
 * ("No gaze sample available" used to abort the command outright.)
 */
async function resolveGazePoint(
  ctx: HintsCtx,
  adapter: ComputerUseAdapter | null
): Promise<{ x: number; y: number } | undefined> {
  const g = ctx.gaze ?? ctx.target?.();
  if (g) return { x: g.x, y: g.y };
  const live = await fetchLiveGaze(ctx);
  if (live) return live;
  try {
    const m = await (adapter as any)?.mousePosition?.();
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) return { x: m.x, y: m.y };
  } catch {
    /* ignore */
  }
  return undefined;
}

async function fetchLiveGaze(
  ctx: HintsCtx,
  timeoutMs: number = GAZE_TIMEOUT.fast
): Promise<{ x: number; y: number } | undefined> {
  // maxAgeMs: ignore stale samples (tracker stopped).
  const sample = await ctx.services.gaze.current({ timeoutMs, maxAgeMs: 2000 });
  return sample ? { x: sample.x, y: sample.y } : undefined;
}

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

class HintModeController {
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
      const cfg = HINT_DENSITY[density(this.ctx.state) === "all" ? "normal" : density(this.ctx.state)];
      const candidates = await collectCandidates(
        this.ctx.state.selector,
        adapter,
        at,
        getErrorRadius(),
        getWindowKey(this.ctx),
        {
          appName: await getFrontmostAppName(this.ctx),
          adapters: this.ctx.services.adapters,
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

// ─── Map watcher: keep a shown map up to date ─────────────────────────────────

/**
 * How often a shown map is re-parsed in the background (ms). 0 disables
 * auto-refresh ("refresh map" still works). KNOWHOW_MAP_REFRESH_MS overrides.
 */
function mapRefreshMs(): number {
  const v = Number(process.env.KNOWHOW_MAP_REFRESH_MS);
  return Number.isFinite(v) && v >= 0 ? v : 3000;
}
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

interface MapSpec {
  density: HintDensity;
  query?: string[];
  gaze: { x: number; y: number };
}

class MapWatcher {
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
    const every = mapRefreshMs();
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

function stopMapWatch(state: HintsState): void {
  state.mapWatch?.stop();
  state.mapWatch = null;
}

/** Parse the window for `spec`. Returns undefined when there's no adapter. */
async function scanMap(ctx: HintsCtx, spec: MapSpec, log: (msg: string) => void): Promise<Candidate[] | undefined> {
  const adapter = getAdapter(ctx);
  if (!adapter) return undefined;
  const cfg = HINT_DENSITY[spec.density];
  return collectCandidates(ctx.state.selector, adapter, spec.gaze, getErrorRadius(), getWindowKey(ctx), {
    query: spec.query,
    wholeWindow: cfg.wholeWindow,
    log,
    appName: await getFrontmostAppName(ctx),
    adapters: ctx.services.adapters,
    scanFactor: cfg.scanFactor,
    maxCandidates: Math.max(20, cfg.labels),
    fullParse: !!cfg.full,
  });
}

/** Publish + draw `candidates` as the map. Returns the labelled list. */
async function drawMap(ctx: HintsCtx, spec: MapSpec, candidates: Candidate[], quiet = false): Promise<Candidate[]> {
  const adapter = getAdapter(ctx);
  const cfg = HINT_DENSITY[spec.density];
  const labelled = publishHints(ctx.state, candidates, cfg.labels, await getFrontmostAppName(ctx));
  if (adapter) await showHintOverlay(ctx.state.selector, adapter, labelled, HINT_OVERLAY_MS, cfg.labels);
  if (!quiet) {
    const listed = labelled.slice(0, 60);
    ctx.log(
      `[hints] Showing ${labelled.length} hint(s) (${
        cfg.full ? "full window" : spec.density
      }; say "more hints" / "fewer hints" to change, "refresh map" to re-parse, "hide map" to remove): ` +
        listed.map((c) => (c.displayName ? `${c.label}=${c.displayName}` : c.label)).join(", ") +
        (labelled.length > listed.length ? `, … +${labelled.length - listed.length} more` : "")
    );
  }
  return labelled;
}

// ─── Shared show-hints logic ──────────────────────────────────────────────────

async function showHintsNear(ctx: HintsCtx, mode: boolean | HintDensity, query?: string[]): Promise<void> {
  const level: HintDensity = mode === true ? "all" : mode === false ? density(ctx.state) : mode;
  if (isHintModeRunning(ctx.state) && level !== "all" && !query?.length) {
    ctx.state.hintMode?.refreshSoon(0);
    return;
  }
  const adapter = getAdapter(ctx);
  if (!adapter) {
    ctx.log("[hints] No computer-use adapter available");
    return;
  }
  const gaze = await resolveGazePoint(ctx, adapter);
  if (!gaze) {
    ctx.log("[hints] No gaze sample available");
    return;
  }
  const spec: MapSpec = { density: level, query, gaze: { x: gaze.x, y: gaze.y } };
  const candidates = (await scanMap(ctx, spec, ctx.log)) ?? [];

  if (!candidates.length) {
    try {
      const elements = await adapter.accessibilityElements({ maxDepth: 8 });
      detectChromeAXStatus(elements, ctx.log);
    } catch {
      /* ignore */
    }
    ctx.log("[hints] No actionable elements found near gaze");
    return;
  }

  await drawMap(ctx, spec, candidates);
  // The map stays up until "hide map"; keep it current in the background
  // (redraws only when the page changed noticeably, numbers kept stable).
  stopMapWatch(ctx.state);
  if (!isHintModeRunning(ctx.state)) {
    ctx.state.mapWatch = new MapWatcher(ctx, spec);
    ctx.state.mapWatch.start();
  }
}

/** "refresh map": re-parse now with the same settings as the map on screen. */
async function refreshMap(ctx: HintsCtx): Promise<void> {
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
function publishHints(
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

// ─── Find best candidate matching a HintRef ───────────────────────────────────

type HintAction = "click" | "focus" | "check" | "rightClick" | "hover";
type HintActionOptions = { newTab?: boolean; typeText?: string };

/** Why a numbered label could not be found (pure; the caller logs it and shows fresh labels). */
export function missingLabelMessage(ref: HintRef, labelsWereOnScreen: boolean): string {
  const what = `${ref.roleName ?? "hint"} ${ref.index}`;
  return labelsWereOnScreen
    ? `[hints] There is no "${what}" on screen — showing fresh labels; say it again`
    : `[hints] The labels have expired, so "${what}" may point at something else now — showing fresh labels; say it again`;
}

/** The words a spoken ref contributes to a candidate query. */
export function queryWordsFor(ref: HintRef): string[] {
  return [ref.name, ref.roleName].filter(Boolean) as string[];
}

/** Pick the freshly-collected candidate a ref means, or say why none (pure). */
export function pickFreshCandidate(
  ref: HintRef,
  candidates: Candidate[],
  gaze: { x: number; y: number }
): { candidate?: Candidate; reason?: "ambiguous" | "no-match" } {
  // Ambiguity only matters when no explicit number or name was given.
  if (isAmbiguous(candidates) && ref.index === undefined && !ref.name) return { reason: "ambiguous" };
  const candidate = resolveHintRef(ref, candidates, gaze);
  // A spoken name that matches nothing must not act on whatever happens
  // to rank first ("mouse over thea" used to hover an unrelated input).
  if (!candidate && ref.name) return { reason: "no-match" };
  // Best guess for role-only refs ("click button").
  return { candidate: candidate ?? candidates[0] };
}

/** Show `candidates` as the hint overlay (publishing their numbering). */
async function showCandidateOverlay(ctx: HintsCtx, adapter: ComputerUseAdapter, candidates: Candidate[]): Promise<void> {
  const labels = HINT_DENSITY[density(ctx.state)].labels;
  await showHintOverlay(
    ctx.state.selector,
    adapter,
    publishHints(ctx.state, candidates, labels, await getFrontmostAppName(ctx)),
    HINT_OVERLAY_MS,
    labels
  );
}

/**
 * Find the on-screen element a ref means: first the labels that were up when
 * you started speaking, else a fresh scan. Returns undefined when it already
 * told the user what to do instead (fresh labels shown, ambiguity, no match).
 */
async function resolveHintCandidate(
  ctx: HintsCtx,
  adapter: ComputerUseAdapter,
  ref: HintRef,
  gaze: { x: number; y: number }
): Promise<Candidate | undefined> {
  // First try the labels that were on screen when you started speaking.
  const existingState = ctx.state.selector.getHintStateAt(ctx.spokenAt);
  const known = existingState ? resolveHintRef(ref, existingState.candidates, gaze) : undefined;
  if (known) return known;

  // A number refers to a label you saw. If that label isn't on screen (expired,
  // or never drawn), a rescan would renumber everything and "text 11" would hit
  // some other element — so show fresh labels and let you say it again.
  if (ref.index !== undefined) {
    ctx.log(missingLabelMessage(ref, !!existingState));
    await showHintsNear(ctx, false);
    return undefined;
  }

  const candidates = await collectCandidates(
    ctx.state.selector,
    adapter,
    { x: gaze.x, y: gaze.y },
    getErrorRadius(),
    getWindowKey(ctx),
    // In full-parse mode a spoken name may be anywhere in the window (gaze
    // still breaks ties between equal matches).
    {
      query: queryWordsFor(ref),
      appName: await getFrontmostAppName(ctx),
      adapters: ctx.services.adapters,
      wholeWindow: !!HINT_DENSITY[density(ctx.state)].full,
    }
  );

  if (!candidates.length) {
    ctx.log(`[hints] No candidates found near gaze`);
    if (ref.roleName && !ref.name) {
      ctx.log(`[hints] No ${ref.roleName} element found near gaze`);
    } else if (ref.name) {
      ctx.log(`[hints] No element named "${ref.name}" near gaze — showing hints`);
      await showHintsNear(ctx, false);
    }
    return undefined;
  }

  const picked = pickFreshCandidate(ref, candidates, gaze);
  if (picked.reason === "ambiguous") {
    await showCandidateOverlay(ctx, adapter, candidates);
    ctx.log("[hints] Ambiguous — showing hints, please specify (e.g. 'button 1')");
    return undefined;
  }
  if (picked.reason === "no-match") {
    ctx.log(`[hints] Nothing matching "${ref.name}" near gaze — showing hints`);
    await showCandidateOverlay(ctx, adapter, candidates);
    return undefined;
  }
  let candidate = picked.candidate;

  // Don't replace a map that's on screen with this query's few matches —
  // the drawn labels must keep meaning what they say.
  if (candidate && !isHintModeRunning(ctx.state) && !ctx.state.selector.getHintState()) {
    const published = publishHints(
      ctx.state,
      candidates,
      HINT_DENSITY[density(ctx.state)].labels,
      await getFrontmostAppName(ctx)
    );
    const chosen = candidate;
    candidate = published.find((c) => c.element === chosen.element) ?? candidate;
  }
  return candidate;
}

/** Do `action` on a resolved candidate (the resolver/adapters decide how the press is delivered). */
async function actOnCandidate(
  ctx: HintsCtx,
  adapter: ComputerUseAdapter,
  candidate: Candidate,
  action: HintAction,
  extra?: HintActionOptions
): Promise<void> {
  const center = centerOf(candidate.element);
  const deps = { pointer: ctx.services.pointer, clock: ctx.services.clock };

  if (extra?.newTab) {
    if (center) {
      await adapter.moveMouse(center);
      await adapter.hotkey("meta");
      await adapter.click("left");
      await postGazeCorrection(center);
    }
    return;
  }

  if (extra?.typeText !== undefined) {
    await activateElement(adapter, candidate, "focus", deps);
    await ctx.services.clock.sleep(100);
    await adapter.typeText(extra.typeText);
    if (center) await postGazeCorrection(center);
    return;
  }

  if (action === "hover") {
    if (center) {
      await adapter.moveMouse(center);
      // Remember position, element AND app so "click that" / "double click that"
      // can hand the hovered element to that app's adapter.
      ctx.services.pointer.notePlaced(center, candidate, await getFrontmostAppName(ctx));
    }
    return;
  }

  await activateElement(adapter, candidate, action, deps);
  ctx.state.hintMode?.refreshSoon();
  ctx.state.mapWatch?.refreshSoon();
}

async function findAndAct(ctx: HintsCtx, ref: HintRef, action: HintAction, extra?: HintActionOptions): Promise<void> {
  const adapter = getAdapter(ctx);
  if (!adapter) {
    ctx.log("[hints] No computer-use adapter available");
    return;
  }
  const gaze = await resolveGazePoint(ctx, adapter);
  if (!gaze) {
    ctx.log("[hints] No gaze sample available");
    return;
  }

  const candidate = await resolveHintCandidate(ctx, adapter, ref, gaze);
  if (!candidate) return;

  ctx.log(`[hints] Acting on: ${candidate.label}${candidate.displayName ? ` (${candidate.displayName})` : ""}`);
  await actOnCandidate(ctx, adapter, candidate, action, extra);
}

// ─── Get hint ref from slots (slot value is a HintRef from grammar) ───────────

function hintRefFromSlots(slots: Record<string, unknown>): HintRef {
  const h = slots.hint;
  if (h && typeof h === "object") return h as HintRef;
  return {};
}

// ─── Command factory ──────────────────────────────────────────────────────────

/**
 * Vocabulary for this pack: "map" is accepted wherever a phrase says "hints"
 * ("hide map", "map all", "more map", "map off" …). Declared once here and
 * expanded when the patterns are compiled (see grammar/compile.ts).
 */
export const HINTS_SYNONYMS: Record<string, string[]> = { hints: ["map"] };

// ─── Pack definition ──────────────────────────────────────────────────────────

export const HINTS_PACK = defineVoicePack<HintsState>({
  name: "hints",
  description: "Gaze + accessibility hints: label elements, click / hover / type by number or name",
  defaults: { repeatable: false, synonyms: HINTS_SYNONYMS },
  createState: (services) => createHintsState(services),
  // Timers and watchers stop with the session (hint mode, map watcher, smart mouse, overlay clear).
  onSessionStop: async ({ state }) => {
    state.mapWatch?.stop();
    state.mapWatch = null;
    state.stopSmartMouse();
    await stopHintMode(state);
    state.selector.dispose();
  },
  commands: ({ command }) => [
    // ── Show hints ──────────────────────────────────────────────────────────────
    command({
      name: "hints.show",
      phrase: "hints",
      patterns: ["hints", "show hints", "hints here", "show hint", "map it", "map this", "map page"],
      description:
        "Label every actionable element in the front window (full parse by default; 'fewer hints' for just the ones near your gaze). 'map' is a synonym",
      repeatable: false,
      run: async (ctx) => showHintsNear(ctx, false),
    }),

    command({
      name: "hints.show-all",
      phrase: "hints all",
      patterns: ["hints all", "show all hints", "hints window", "full hints", "reset hints"],
      description: "Label every actionable element in the window and make that the default again",
      repeatable: false,
      run: async (ctx) => {
        ctx.state.density = "all";
        await showHintsNear(ctx, true);
      },
    }),

    command({
      name: "hints.more",
      phrase: "more hints",
      patterns: ["more hints", "show more hints", "hints more", "more labels"],
      description: "Show more hints around your gaze (wider area, more labels); sticky for later 'hints'",
      repeatable: false,
      run: async (ctx) => showHintsNear(ctx, stepDensity(ctx.state, 1)),
    }),

    command({
      name: "hints.fewer",
      phrase: "fewer hints",
      patterns: [
        "fewer hints",
        "less hints",
        "hints less",
        "hints fewer",
        "show fewer hints",
        "show less hints",
        "few hints",
        "smaller hints",
      ],
      description: "Show only the few hints closest to your gaze; sticky for later 'hints'",
      repeatable: false,
      run: async (ctx) => showHintsNear(ctx, stepDensity(ctx.state, -1)),
    }),

    command({
      name: "hints.normal",
      phrase: "normal hints",
      patterns: ["normal hints", "hints normal"],
      description: "Switch to gaze-centred hints (about 15 labels near where you look)",
      repeatable: false,
      run: async (ctx) => {
        ctx.state.density = "normal";
        await showHintsNear(ctx, "normal");
      },
    }),

    command({
      name: "hints.refresh",
      phrase: "refresh map",
      patterns: ["refresh map", "refresh hints", "update hints", "reload hints", "remap"],
      description: "Re-parse the window and redraw the map now (numbers of unchanged elements stay the same)",
      repeatable: false,
      run: async (ctx) => refreshMap(ctx),
    }),

    command({
      name: "hints.hide",
      phrase: "hide hints",
      patterns: ["hide hints", "clear hints", "no hints", "hints off", "close hints"],
      description: "Remove the hint labels",
      repeatable: false,
      run: async (ctx) => {
        if (isHintModeRunning(ctx.state)) {
          await stopHintMode(ctx.state);
          ctx.log("[hints] Hint mode OFF");
        }
        stopMapWatch(ctx.state);
        ctx.state.selector.clearHintState();
        await getAdapter(ctx)
          ?.clearOverlay()
          .catch(() => undefined);
      },
    }),

    command({
      name: "hints.mode",
      phrase: "hint mode",
      patterns: ["hint mode", "hints mode", "hint mode on", "hints on", "follow hints", "live hints"],
      description:
        "Keep hint labels on near wherever you look (they refresh as your gaze settles somewhere new); 'hide hints' or 'hint mode off' to stop",
      repeatable: false,
      run: (ctx) => {
        if (isHintModeRunning(ctx.state)) {
          ctx.log("[hints] Hint mode already ON");
          return;
        }
        stopMapWatch(ctx.state);
        ctx.state.hintMode = new HintModeController(ctx);
        ctx.state.hintMode.start();
        ctx.log(
          "[hints] Hint mode ON — labels follow your gaze; say 'click <text>', 'mouse over text 3', 'hint mode off'"
        );
      },
    }),

    command({
      name: "hints.mode-off",
      phrase: "hint mode off",
      patterns: ["hint mode off", "hints mode off", "stop hint mode", "exit hint mode"],
      description: "Stop hint mode and remove the labels",
      repeatable: false,
      run: async (ctx) => {
        await stopHintMode(ctx.state);
        stopMapWatch(ctx.state);
        ctx.state.selector.clearHintState();
        await getAdapter(ctx)
          ?.clearOverlay()
          .catch(() => undefined);
        ctx.log("[hints] Hint mode OFF");
      },
    }),

    // ── Click — plain gaze click (no hint) ─────────────────────────────────────
    // "click" alone stays a gaze click. "click {hint}" routes to the hint click below.
    // NOTE: This command is defined in the gazeMouse pack. We do NOT redefine it here.
    // The hints.click-hint below handles "click <hint>" via grammar pattern.

    // ── Click with hint ─────────────────────────────────────────────────────────
    command({
      name: "hints.click-hint",
      phrase: "click hint",
      patterns: ["click {hint:hintphrase}", "click on {hint:hintphrase}"],
      description: "Click a specific element by hint: 'click button 2', 'click save', 'click link 3'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "click");
      },
      maxAudioMs: 10000,
    }),

    // ── Move the mouse to a hint (no click) ─────────────────────────────────────
    command({
      name: "hints.hover-hint",
      phrase: "hover hint",
      patterns: [
        "hover over {hint:hintphrase}",
        "hover {hint:hintphrase}",
        "mouse over {hint:hintphrase}",
        "mouse to {hint:hintphrase}",
        "move mouse to {hint:hintphrase}",
        "move the mouse to {hint:hintphrase}",
        "move cursor to {hint:hintphrase}",
        "move to {hint:hint}",
        "point at {hint:hintphrase}",
      ],
      description:
        "Move the mouse onto an element without clicking: 'hover button 2', 'mouse to text 3', 'move to save'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "hover");
      },
      maxAudioMs: 10000,
    }),

    // ── Select / focus ──────────────────────────────────────────────────────────
    command({
      name: "hints.select-hint",
      phrase: "select hint",
      patterns: ["select {hint:hint}", "focus {hint:hint}"],
      description: "Focus/select a specific element: 'select input 2', 'select field', 'focus button'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "focus");
      },
    }),

    // ── Type in a specific field (role+number or name) ──────────────────────────
    command({
      name: "hints.type-in",
      phrase: "type in hint",
      patterns: ["type in {hint:hint} {text:text}", "type {hint:hint} {text:text}"],
      description: "Type text into a specific field: 'type in input 2 hello world', 'type message hello'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        const text = (ctx.slots.text as string | undefined) ?? "";

        if (!ref.roleName && !ref.name && !ref.index) {
          // Shouldn't happen with grammar routing, but guard it
          ctx.log("[hints] Usage: type in <field> <text>");
          return;
        }

        // If ref has a name, try to find a matching input field near gaze.
        // If no field found with that name, fall back to typing the whole text
        // (treating the name as part of the text was a plain "type" command).
        if (ref.name && !ref.roleName && !ref.index) {
          const adapter = getAdapter(ctx);
          if (adapter) {
            const gaze = ctx.gaze ?? ctx.target?.();
            if (gaze) {
              const errorRadius = getErrorRadius();
              const windowKey = getWindowKey(ctx);
              const candidates = await collectCandidates(
                ctx.state.selector,
                adapter,
                { x: gaze.x, y: gaze.y },
                errorRadius,
                windowKey,
                {
                  query: ref.name.split(/\s+/),
                }
              );
              const inputCandidates = candidates.filter(
                (c) =>
                  ["input", "select"].includes(c.roleName) &&
                  ((c.element.title ?? "").toLowerCase().includes(ref.name!.toLowerCase()) ||
                    (c.element.description ?? "").toLowerCase().includes(ref.name!.toLowerCase()) ||
                    (c.displayName ?? "").toLowerCase().includes(ref.name!.toLowerCase()))
              );
              if (inputCandidates.length) {
                // Found a field — focus it and type the text
                await findAndAct(ctx, ref, "focus", { typeText: text });
                return;
              }
            }
          }
          // No field found — fall back: type the full original text (name + text combined)
          // This handles: "type message hello" when no "message" field exists → types "message hello"
          // Apply the same dictation conversion as the plain `type` command so
          // spoken punctuation ("new line", "comma", …) works here too.
          const joined = [ref.name, text]
            .filter(Boolean)
            .join(" ")
            .replace(/^["\u201C](.+?)["\u201D]$/, "$1")
            .replace(/\.$/, "")
            .trim();
          const fullText = convertDictation(joined);
          ctx.log(`[hints] No field named "${ref.name}" near gaze — typing full text: "${fullText}"`);
          if (ctx.actions) {
            await ctx.actions.typeText(fullText);
          } else if (ctx.mouse) {
            // Best effort: use typeText via platform
            ctx.log(`[hints] No platform actions available to type text`);
          }
          return;
        }

        // Role or index reference — go straight to findAndAct
        await findAndAct(ctx, ref, "focus", { typeText: text });
      },
    }),

    // ── Bare hint (role+number only, to avoid stealing plain words) ─────────────
    // "button 2", "input 3", "link 1" alone — role MUST be present, number is required
    // to prevent single role words ("button") stealing unrelated commands.
    command({
      name: "hints.bare-hint",
      phrase: "hint",
      patterns: ["{hint:hintref}"],
      description: "Act on a hint by role+number alone: 'button 2', 'input 1', 'link 3'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        // For bare hint, require either a number or a name (not just a bare role word)
        // to avoid false triggers on single role words that might appear in other speech.
        if (!ref.index && !ref.name) {
          // Just a bare role word — show hints and wait
          await showHintsNear(ctx, false, ref.roleName ? [ref.roleName] : []);
          return;
        }
        await findAndAct(ctx, ref, "click");
      },
    }),

    // ── Links ───────────────────────────────────────────────────────────────────
    command({
      name: "hints.open-link",
      phrase: "open link hint",
      patterns: [
        "open {hint:hint} in new tab",
        "open link {hint:hint} in new tab",
        "open {hint:hint}",
        "open link {hint:hint}",
        "link {hint:hint}",
      ],
      description: "Open a link: 'link 3', 'open link 3', 'open link 3 in new tab'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        // Force role to "link" if not set
        const linkRef: HintRef = { ...ref, roleName: ref.roleName ?? "link" };
        const newTab = /\bin\s+new\s+tab\b/i.test(ctx.text);
        await findAndAct(ctx, linkRef, "click", { newTab });
      },
    }),

    // ── Checkbox ────────────────────────────────────────────────────────────────
    command({
      name: "hints.check",
      phrase: "check hint",
      patterns: ["check {hint:hint}", "toggle {hint:hint}"],
      aliases: ["check box", "check checkbox", "toggle check"],
      description: "Toggle a checkbox near gaze: 'check box 1', 'check 2'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        const checkRef: HintRef = { ...ref, roleName: ref.roleName ?? "check" };
        await findAndAct(ctx, checkRef, "check");
      },
    }),

    // ── Right click ─────────────────────────────────────────────────────────────
    command({
      name: "hints.right-click",
      phrase: "right click hint",
      patterns: ["right click {hint:hintphrase}"],
      description: "Right-click a hint reference: 'right click button 2', 'right click save'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "rightClick");
      },
    }),

    // ── Navigation ──────────────────────────────────────────────────────────────
    command({
      name: "hints.next",
      phrase: "next hint",
      patterns: ["next hint", "next"],
      aliases: ["next hint"],
      description: "Move selection to the next hint candidate",
      repeatable: false,
      run: (ctx) => {
        const state = ctx.state.selector.getHintState();
        if (!state || !state.candidates.length) {
          ctx.log("[hints] No hints active");
          return;
        }
        state.selectedIndex = (state.selectedIndex + 1) % state.candidates.length;
        ctx.log(`[hints] Selected: ${state.candidates[state.selectedIndex].label}`);
      },
    }),

    command({
      name: "hints.previous",
      phrase: "previous hint",
      patterns: ["previous hint", "previous", "prev hint", "prev"],
      aliases: ["prev", "previous hint", "prev hint"],
      description: "Move selection to the previous hint candidate",
      repeatable: false,
      run: (ctx) => {
        const state = ctx.state.selector.getHintState();
        if (!state || !state.candidates.length) {
          ctx.log("[hints] No hints active");
          return;
        }
        state.selectedIndex = (state.selectedIndex - 1 + state.candidates.length) % state.candidates.length;
        ctx.log(`[hints] Selected: ${state.candidates[state.selectedIndex].label}`);
      },
    }),

    // ── Smart mouse ─────────────────────────────────────────────────────────────
    command({
      name: "hints.smart-mouse",
      phrase: "smart mouse",
      patterns: ["smart mouse", "magnetic cursor", "snap mouse"],
      description: "Start gaze-following mode that snaps the cursor to the nearest element",
      repeatable: false,
      run: async (ctx) => {
        if (ctx.state.smartMouse?.isRunning()) {
          ctx.log("[hints] Smart mouse already running");
          return;
        }
        const adapter = getAdapter(ctx);
        if (!adapter) {
          ctx.log("[hints] No computer-use adapter available for smart mouse");
          return;
        }
        ctx.state.selector.invalidateAXCache();
        ctx.state.smartMouse = new SmartMouseController(adapter, () => getWindowKey(ctx), {
          errorRadius: getErrorRadius(),
          clock: ctx.services.clock,
          selector: ctx.state.selector,
        });
        ctx.state.smartMouse.start();
        ctx.log("[hints] Smart mouse started — say 'stop mouse' to stop");
      },
    }),

    command({
      name: "hints.stop-smart-mouse",
      phrase: "stop smart mouse",
      patterns: ["stop smart mouse"],
      description: "Stop the smart mouse gaze-follow controller",
      repeatable: false,
      run: (ctx) => {
        if (ctx.state.smartMouse?.isRunning()) {
          ctx.state.smartMouse.stop();
          ctx.state.smartMouse = null;
          ctx.log("[hints] Smart mouse stopped");
        } else {
          ctx.log("[hints] Smart mouse was not running");
          ctx.gazeFollow?.stop();
        }
      },
    }),

    // ── play <song> — AXPress the "Play <song> by …" button ─────────────────────
    // "play a real hero", "play rubber head", "click play a real hero"
    // Bare "play" and "pause" are media keys (handled elsewhere); this command
    // only fires when at least one song-name word follows "play".
    command({
      name: "hints.play-song",
      phrase: "play song",
      patterns: ["play {song:songphrase}", "click play {song:songphrase}"],
      description:
        "Play a track by name: 'play a real hero', 'click play rubber head'. The front app's adapter finds the play button and it is AXPressed.",
      run: async (ctx) => {
        const adapter = getAdapter(ctx);
        if (!adapter) {
          ctx.log("[hints] No computer-use adapter available");
          return;
        }
        const gaze = await resolveGazePoint(ctx, adapter);
        // Extract song name from slot or from text
        const songSlot = ctx.slots.song;
        let songQuery: string[];
        if (songSlot && typeof songSlot === "object" && "name" in (songSlot as any)) {
          const ref = songSlot as { name?: string; roleName?: string };
          songQuery = (ref.name ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        } else if (typeof songSlot === "string") {
          songQuery = (songSlot as string).toLowerCase().split(/\s+/).filter(Boolean);
        } else {
          // Parse song name from raw text: strip leading "play " or "click play "
          const raw = ctx.text
            .toLowerCase()
            .replace(/^click\s+/, "")
            .replace(/^play\s+/, "")
            .trim();
          songQuery = raw.split(/\s+/).filter(Boolean);
        }
        if (!songQuery.length) {
          ctx.log("[hints] No song name provided");
          return;
        }
        ctx.log(`[hints] Looking for play button for: "${songQuery.join(" ")}"`);
        // The front app's adapter knows how to find "play <name>" (media apps); any adapter that can will do.
        const app = await getFrontmostAppName(ctx);
        const playAdapter =
          ctx.services.adapters.find(app, "playTarget") ??
          ctx.services.adapters.list().find((a) => a.playTarget);
        const candidate = await playAdapter?.playTarget?.(songQuery, gaze ?? { x: 960, y: 540 }, ctx.services);
        if (!candidate) {
          ctx.log(`[hints] No play button found for "${songQuery.join(" ")}"`);
          return;
        }
        ctx.log(`[hints] Pressing play: ${candidate.displayName ?? candidate.label}`);
        await activateElement(adapter, candidate, "click", {
          pointer: ctx.services.pointer,
          clock: ctx.services.clock,
        });
        ctx.state.hintMode?.refreshSoon();
      },
      maxAudioMs: 12000,
    }),

    // "click that" / "double click that" live in voiceCommands.ts (click-that,
    // double-click); the latter keeps the remembered-element behaviour.
  ],
});
