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
  VoiceCommandExtension,
  VOICE_COMMAND_EXTENSION,
  VoiceCommandContext,
} from "../voiceCommands";
import {
  parseHintRef,
  resolveHintRef,
  rankCandidates,
  collectCandidates,
  isAmbiguous,
  showHintOverlay,
  buildHintOverlayPrimitives,
  activateElement,
  clearHintState,
  getHintState,
  setHintState,
  HintState,
  Candidate,
  ComputerUseAdapter,
  postGazeCorrection,
  SmartMouseController,
  detectChromeAXStatus,
  invalidateAXCache,
  HINT_DENSITY,
  HintDensity,
  getHintStateAt,
  stabilizeLabels,
  notePointerPlaced,
  findPlayButton,
  recentPlacedCandidate,
} from "../smartSelector";
import { HintRef } from "../grammar/slots";
import { clickThat, doubleClickTarget } from "../pointerMemory";
import { convertDictation } from "../grammar/dictation";
import { getComputerService } from "../computerService";
import { spawnSync } from "child_process";

// ─── Frontmost app name ───────────────────────────────────────────────────────

let _frontAppCache: { at: number; name: string | undefined } | undefined;

function getFrontmostAppName(): string | undefined {
  // Blocking osascript call: cache briefly (scan + publish ask back to back,
  // and the map watcher asks every few seconds).
  if (_frontAppCache && Date.now() - _frontAppCache.at < 1000) return _frontAppCache.name;
  const name = readFrontmostAppName();
  _frontAppCache = { at: Date.now(), name };
  return name;
}

function readFrontmostAppName(): string | undefined {
  try {
    const result = spawnSync(
      "osascript",
      ["-l", "JavaScript", "-e",
        `ObjC.import('AppKit'); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName);`],
      { encoding: "utf8", timeout: 2000 },
    );
    if (result.status === 0 && result.stdout?.trim()) return result.stdout.trim();
  } catch { /* ignore */ }
  return undefined;
}

// ─── Smart mouse singleton ────────────────────────────────────────────────────

let _smartMouse: SmartMouseController | null = null;

// ─── Resolve computer-use adapter from context ────────────────────────────────

function getAdapter(ctx: VoiceCommandContext): ComputerUseAdapter | null {
  const cu = getComputerService();
  return cu ? (cu as ComputerUseAdapter) : null;
}

/**
 * Stop the smart mouse singleton (called by gaze-mouse pack's stop-mouse command).
 */
export function stopSmartMouse(): void {
  if (_smartMouse?.isRunning()) {
    _smartMouse.stop();
    _smartMouse = null;
  }
}

function getWindowKey(ctx: VoiceCommandContext): string {
  const t = ctx.target?.();
  return t ? `${Math.round(t.x / 100)}_${Math.round(t.y / 100)}` : "default";
}

function getErrorRadius(): { x: number; y: number } {
  return { x: 200, y: 260 };
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

/** Sticky density for "hints": "fewer hints" / "more hints" change it. */
let _density: HintDensity = initialDensity();

export function getHintDensity(): HintDensity {
  return _density;
}

export function setHintDensity(d: HintDensity): void {
  _density = d;
}

function stepDensity(dir: 1 | -1): HintDensity {
  const i = DENSITY_ORDER.indexOf(_density);
  const next = DENSITY_ORDER[Math.max(0, Math.min(DENSITY_ORDER.length - 1, i + dir))];
  // "more hints" past "more" reaches the full-window parse ("all").
  _density = next;
  return next;
}

// ─── Gaze source ──────────────────────────────────────────────────────────────

const HUB_URL = process.env.KNOWHOW_EYE_HUB_URL ?? "http://127.0.0.1:7465";

/**
 * Where to look for hints: the gaze at speech onset, else the gaze-follow
 * position, else the live gaze from the eye-tracking hub, else the mouse.
 * ("No gaze sample available" used to abort the command outright.)
 */
async function resolveGazePoint(ctx: VoiceCommandContext, adapter: ComputerUseAdapter | null): Promise<{ x: number; y: number } | undefined> {
  const g = ctx.gaze ?? ctx.target?.();
  if (g) return { x: g.x, y: g.y };
  const live = await fetchLiveGaze();
  if (live) return live;
  try {
    const m = await (adapter as any)?.mousePosition?.();
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) return { x: m.x, y: m.y };
  } catch { /* ignore */ }
  return undefined;
}

async function fetchLiveGaze(timeoutMs = 150): Promise<{ x: number; y: number } | undefined> {
  try {
    const res = await fetch(`${HUB_URL}/api/gaze`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const sample = (await res.json()) as { x?: number; y?: number; timestamp?: number };
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return undefined;
    // Ignore stale samples (tracker stopped).
    if (sample.timestamp && Date.now() - sample.timestamp > 2000) return undefined;
    return { x: sample.x as number, y: sample.y as number };
  } catch {
    return undefined;
  }
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
  private timer?: NodeJS.Timeout;
  private running = false;
  private scanning = false;
  private anchor?: { x: number; y: number };
  private lastScanAt = 0;
  private dwell?: { x: number; y: number; since: number };
  private forceAt = 0;

  constructor(private readonly ctx: VoiceCommandContext) {}

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.forceAt = Date.now();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    clearHintState();
    await getComputerService()?.clearOverlay?.().catch(() => undefined);
  }

  /** Rescan soon (e.g. after a click changed the page). */
  refreshSoon(delayMs = 700): void {
    if (this.running) this.forceAt = Date.now() + delayMs;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const gaze = await fetchLiveGaze();
      const now = Date.now();
      if (gaze && !this.scanning) {
        if (!this.dwell || Math.hypot(gaze.x - this.dwell.x, gaze.y - this.dwell.y) > HINT_MODE_DWELL_PX) {
          this.dwell = { ...gaze, since: now };
        }
        const settled = now - this.dwell.since >= HINT_MODE_DWELL_MS;
        const moved = !this.anchor || Math.hypot(this.dwell.x - this.anchor.x, this.dwell.y - this.anchor.y) > HINT_MODE_MOVE_PX;
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
    const adapter = getComputerService() as ComputerUseAdapter | null;
    if (!adapter) return;
    this.scanning = true;
    try {
      const cfg = HINT_DENSITY[_density === "all" ? "normal" : _density];
      const candidates = await collectCandidates(adapter, at, getErrorRadius(), getWindowKey(this.ctx), {
        appName: getFrontmostAppName(),
        scanFactor: cfg.scanFactor,
        maxCandidates: Math.max(20, cfg.labels),
        log: () => undefined, // quiet: this runs every few seconds
      });
      if (!this.running) return;
      this.anchor = at;
      this.lastScanAt = Date.now();
      if (!candidates.length) return;
      // Keep numbers stable across refreshes and only keep labels that are drawn.
      const shown = stabilizeLabels(getHintState()?.candidates, candidates.slice(0, cfg.labels));
      setHintState({ candidates: shown, timestamp: Date.now(), selectedIndex: -1, ttlMs: HINT_MODE_TTL_MS });
      await showHintOverlay(adapter, shown, HINT_MODE_TTL_MS, cfg.labels);
    } finally {
      this.scanning = false;
    }
  }
}

let _hintMode: HintModeController | null = null;

export function isHintModeRunning(): boolean {
  return !!_hintMode?.isRunning();
}

export async function stopHintMode(): Promise<void> {
  const m = _hintMode;
  _hintMode = null;
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
    const b = c.element.bounds, pb = p?.element.bounds;
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
  private timer?: NodeJS.Timeout;
  private running = false;
  private scanning = false;
  private pendingChanges = 0;
  private forceAt = 0;

  constructor(private readonly ctx: VoiceCommandContext, readonly spec: MapSpec) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Rescan soon (after a click, the page probably changed). */
  refreshSoon(delayMs = 900): void {
    if (!this.running) return;
    this.forceAt = Date.now() + delayMs;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(delayMs);
  }

  private schedule(ms?: number): void {
    const every = mapRefreshMs();
    if (!this.running || (ms === undefined && every <= 0)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms ?? every);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.scanning) return this.schedule();
    this.scanning = true;
    try {
      const prev = getHintState()?.candidates;
      if (!prev) { this.stop(); return; } // hidden elsewhere
      const forced = this.forceAt > 0 && Date.now() >= this.forceAt;
      const next = await scanMap(this.ctx, this.spec, () => undefined);
      if (!this.running || !next) return;
      const change = mapChangeFraction(prev, next.slice(0, HINT_DENSITY[this.spec.density].labels));
      if (change < MAP_CHANGE_THRESHOLD) {
        this.pendingChanges = 0;
        if (!forced) return;
        if (change === 0) { this.forceAt = 0; return; }
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

let _mapWatch: MapWatcher | null = null;

function stopMapWatch(): void {
  _mapWatch?.stop();
  _mapWatch = null;
}

/** Parse the window for `spec`. Returns undefined when there's no adapter. */
async function scanMap(
  ctx: VoiceCommandContext,
  spec: MapSpec,
  log: (msg: string) => void,
): Promise<Candidate[] | undefined> {
  const adapter = getAdapter(ctx);
  if (!adapter) return undefined;
  const cfg = HINT_DENSITY[spec.density];
  return collectCandidates(adapter, spec.gaze, getErrorRadius(), getWindowKey(ctx), {
    query: spec.query,
    wholeWindow: cfg.wholeWindow,
    log,
    appName: getFrontmostAppName(),
    scanFactor: cfg.scanFactor,
    maxCandidates: Math.max(20, cfg.labels),
    fullParse: !!cfg.full,
  });
}

/** Publish + draw `candidates` as the map. Returns the labelled list. */
async function drawMap(ctx: VoiceCommandContext, spec: MapSpec, candidates: Candidate[], quiet = false): Promise<Candidate[]> {
  const adapter = getAdapter(ctx);
  const cfg = HINT_DENSITY[spec.density];
  const labelled = publishHints(candidates, cfg.labels);
  if (adapter) await showHintOverlay(adapter, labelled, HINT_OVERLAY_MS, cfg.labels);
  if (!quiet) {
    const listed = labelled.slice(0, 60);
    ctx.log(
      `[hints] Showing ${labelled.length} hint(s) (${cfg.full ? "full window" : spec.density}; say "more hints" / "fewer hints" to change, "refresh map" to re-parse, "hide map" to remove): ` +
        listed.map((c) => (c.displayName ? `${c.label}=${c.displayName}` : c.label)).join(", ") +
        (labelled.length > listed.length ? `, … +${labelled.length - listed.length} more` : ""),
    );
  }
  return labelled;
}

// ─── Shared show-hints logic ──────────────────────────────────────────────────

async function showHintsNear(
  ctx: VoiceCommandContext,
  mode: boolean | HintDensity,
  query?: string[],
): Promise<void> {
  const density: HintDensity = mode === true ? "all" : mode === false ? _density : mode;
  if (isHintModeRunning() && density !== "all" && !query?.length) {
    _hintMode?.refreshSoon(0);
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
  const spec: MapSpec = { density, query, gaze: { x: gaze.x, y: gaze.y } };
  const candidates = (await scanMap(ctx, spec, ctx.log)) ?? [];

  if (!candidates.length) {
    try {
      const elements = await adapter.accessibilityElements({ maxDepth: 8 });
      detectChromeAXStatus(elements, ctx.log);
    } catch { /* ignore */ }
    ctx.log("[hints] No actionable elements found near gaze");
    return;
  }

  await drawMap(ctx, spec, candidates);
  // The map stays up until "hide map"; keep it current in the background
  // (redraws only when the page changed noticeably, numbers kept stable).
  stopMapWatch();
  if (!isHintModeRunning()) {
    _mapWatch = new MapWatcher(ctx, spec);
    _mapWatch.start();
  }
}

/** "refresh map": re-parse now with the same settings as the map on screen. */
async function refreshMap(ctx: VoiceCommandContext): Promise<void> {
  if (isHintModeRunning()) {
    _hintMode?.refreshSoon(0);
    return;
  }
  const spec = _mapWatch?.spec;
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
function publishHints(candidates: Candidate[], maxLabels: number): Candidate[] {
  const next = candidates.slice(0, maxLabels);
  // Same UI → same numbers: reuse the numbering of the map on screen, or of
  // the last map shown for this app (even after "hide map"), as long as it's
  // recognisably the same page. A different page gets fresh reading-order
  // numbers instead of a patchwork of old ones.
  const app = getFrontmostAppName() ?? "";
  const prev = getHintState()?.candidates ?? _lastMapByApp.get(app);
  const base = prev?.length && mapChangeFraction(prev, next) < MAP_SAME_PAGE_MAX_CHANGE ? prev : undefined;
  const shown = stabilizeLabels(base, next);
  setHintState({ candidates: shown, timestamp: Date.now(), selectedIndex: -1, ttlMs: HINT_STATE_TTL_MS });
  _lastMapByApp.set(app, shown);
  return shown;
}

/** Last map shown per app, so re-showing the same UI gives the same numbers. */
const _lastMapByApp = new Map<string, Candidate[]>();
/** Above this change fraction a map is treated as a different page (fresh numbering). */
const MAP_SAME_PAGE_MAX_CHANGE = 0.5;

// ─── Find best candidate matching a HintRef ───────────────────────────────────

async function findAndAct(
  ctx: VoiceCommandContext,
  ref: HintRef,
  action: "click" | "focus" | "check" | "rightClick" | "hover",
  extraOptions?: { newTab?: boolean; typeText?: string },
): Promise<void> {
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

  const errorRadius = getErrorRadius();
  const windowKey = getWindowKey(ctx);

  // First try the labels that were on screen when you started speaking.
  let candidate: Candidate | undefined;
  const existingState = getHintStateAt(ctx.spokenAt);
  if (existingState) {
    candidate = resolveHintRef(ref, existingState.candidates, gaze);
  }

  // A number refers to a label you saw. If that label isn't on screen (expired,
  // or never drawn), a rescan would renumber everything and "text 11" would hit
  // some other element — so show fresh labels and let you say it again.
  if (!candidate && ref.index !== undefined) {
    const what = `${ref.roleName ?? "hint"} ${ref.index}`;
    ctx.log(
      existingState
        ? `[hints] There is no "${what}" on screen — showing fresh labels; say it again`
        : `[hints] The labels have expired, so "${what}" may point at something else now — showing fresh labels; say it again`,
    );
    await showHintsNear(ctx, false);
    return;
  }

  if (!candidate) {
    // Collect fresh candidates
    const queryWords = [ref.name, ref.roleName].filter(Boolean) as string[];
    const appName = getFrontmostAppName();
    const candidates = await collectCandidates(
      adapter,
      { x: gaze.x, y: gaze.y },
      errorRadius,
      windowKey,
      // In full-parse mode a spoken name may be anywhere in the window (gaze
      // still breaks ties between equal matches).
      { query: queryWords, appName, wholeWindow: !!HINT_DENSITY[_density].full },
    );

    if (!candidates.length) {
      ctx.log(`[hints] No candidates found near gaze`);
      // Fall back: if it was a role-only reference and no element found, log clearly
      if (ref.roleName && !ref.name) {
        ctx.log(`[hints] No ${ref.roleName} element found near gaze`);
      } else if (ref.name) {
        ctx.log(`[hints] No element named "${ref.name}" near gaze — showing hints`);
        await showHintsNear(ctx, false);
      }
      return;
    }

    // Check ambiguity (only when no explicit number given)
    if (isAmbiguous(candidates) && ref.index === undefined && !ref.name) {
      await showHintOverlay(adapter, publishHints(candidates, HINT_DENSITY[_density].labels), HINT_OVERLAY_MS, HINT_DENSITY[_density].labels);
      ctx.log("[hints] Ambiguous — showing hints, please specify (e.g. 'button 1')");
      return;
    }

    candidate = resolveHintRef(ref, candidates, gaze);
    if (!candidate && ref.name) {
      // A spoken name that matches nothing must not act on whatever happens
      // to rank first ("mouse over thea" used to hover an unrelated input).
      ctx.log(`[hints] Nothing matching "${ref.name}" near gaze — showing hints`);
      await showHintOverlay(adapter, publishHints(candidates, HINT_DENSITY[_density].labels), HINT_OVERLAY_MS, HINT_DENSITY[_density].labels);
      return;
    }
    if (!candidate) {
      candidate = candidates[0]; // Best guess for role-only refs ("click button")
    }

    // Don't replace a map that's on screen with this query's few matches —
    // the drawn labels must keep meaning what they say.
    if (!isHintModeRunning() && !getHintState()) {
      const published = publishHints(candidates, HINT_DENSITY[_density].labels);
      const chosen = candidate;
      candidate = published.find((c) => c.element === chosen.element) ?? candidate;
    }
  }

  if (!candidate) {
    ctx.log(`[hints] Could not resolve hint reference`);
    return;
  }

  ctx.log(`[hints] Acting on: ${candidate.label}${candidate.displayName ? ` (${candidate.displayName})` : ""}`);

  if (extraOptions?.newTab) {
    const bounds = candidate.element.bounds;
    if (bounds) {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      await adapter.moveMouse({ x: cx, y: cy });
      await adapter.hotkey("meta");
      await adapter.click("left");
      await postGazeCorrection({ x: cx, y: cy });
    }
    return;
  }

  if (extraOptions?.typeText !== undefined) {
    await activateElement(adapter, candidate, "focus");
    await new Promise((r) => setTimeout(r, 100));
    await adapter.typeText(extraOptions.typeText);
    const bounds = candidate.element.bounds;
    if (bounds) {
      await postGazeCorrection({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    }
    return;
  }

  if (action === "hover") {
    const b = candidate.element.bounds;
    if (b) {
      const p = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      await adapter.moveMouse(p);
      // Remember both position AND element so "click that" / "double click that"
      // can AXPress the hovered element (Spotify hover-only play buttons).
      notePointerPlaced(p, candidate);
    }
    return;
  }

  await activateElement(adapter, candidate, action);
  _hintMode?.refreshSoon();
  _mapWatch?.refreshSoon();
}

// ─── Get hint ref from slots (slot value is a HintRef from grammar) ───────────

function hintRefFromSlots(slots: Record<string, unknown>): HintRef {
  const h = slots.hint;
  if (h && typeof h === "object") return h as HintRef;
  return {};
}

// ─── Command factory ──────────────────────────────────────────────────────────

function cmd(
  name: string,
  phrase: string,
  patterns: string[],
  aliases: string[],
  description: string,
  run: VoiceCommandExtension["run"],
): VoiceCommandExtension {
  return {
    type: VOICE_COMMAND_EXTENSION,
    name,
    phrase,
    patterns,
    aliases,
    description,
    repeatable: false,
    run,
  } as VoiceCommandExtension;
}

// ─── Pack definition ──────────────────────────────────────────────────────────

export const HINTS_PACK: VoiceCommandExtension[] = [
  // ── Show hints ──────────────────────────────────────────────────────────────
  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.show",
    phrase: "hints",
    patterns: ["hints", "show hints", "hints here", "show hint", "map", "show map", "map it", "map this", "map page"],
    aliases: ["show hints", "hints here", "show hint", "map", "show map", "map it", "map this", "map page"],
    description: "Label every actionable element in the front window (full parse by default; 'fewer hints' for just the ones near your gaze). 'map' is a synonym",
    repeatable: false,
    run: async (ctx) => showHintsNear(ctx, false),
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.show-all",
    phrase: "hints all",
    patterns: ["hints all", "show all hints", "hints window", "map all", "full map", "reset hints", "reset map", "full hints"],
    aliases: ["show all hints", "hints window", "map all", "full map", "reset hints", "reset map", "full hints"],
    description: "Label every actionable element in the window and make that the default again",
    repeatable: false,
    run: async (ctx) => {
      _density = "all";
      await showHintsNear(ctx, true);
    },
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.more",
    phrase: "more hints",
    patterns: ["more hints", "show more hints", "hints more", "more labels", "more map"],
    aliases: ["show more hints", "hints more", "more labels", "more map"],
    description: "Show more hints around your gaze (wider area, more labels); sticky for later 'hints'",
    repeatable: false,
    run: async (ctx) => showHintsNear(ctx, stepDensity(1)),
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.fewer",
    phrase: "fewer hints",
    patterns: ["fewer hints", "less hints", "hints less", "hints fewer", "show fewer hints", "show less hints", "few hints", "smaller map", "less map"],
    aliases: ["less hints", "hints less", "hints fewer", "show fewer hints", "show less hints", "few hints", "smaller map", "less map"],
    description: "Show only the few hints closest to your gaze; sticky for later 'hints'",
    repeatable: false,
    run: async (ctx) => showHintsNear(ctx, stepDensity(-1)),
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.normal",
    phrase: "normal hints",
    patterns: ["normal hints", "hints normal", "normal map"],
    aliases: ["hints normal", "normal map"],
    description: "Switch to gaze-centred hints (about 15 labels near where you look)",
    repeatable: false,
    run: async (ctx) => {
      _density = "normal";
      await showHintsNear(ctx, "normal");
    },
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.refresh",
    phrase: "refresh map",
    patterns: ["refresh map", "refresh hints", "update map", "update hints", "reload map", "reload hints", "remap"],
    aliases: ["refresh hints", "update map", "update hints", "reload map", "reload hints", "remap"],
    description: "Re-parse the window and redraw the map now (numbers of unchanged elements stay the same)",
    repeatable: false,
    run: async (ctx) => refreshMap(ctx),
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.hide",
    phrase: "hide hints",
    patterns: ["hide hints", "clear hints", "no hints", "hints off", "hide map", "clear map", "map off", "no map", "close map"],
    aliases: ["clear hints", "no hints", "hints off", "hide map", "clear map", "map off", "no map", "close map"],
    description: "Remove the hint labels",
    repeatable: false,
    run: async (ctx) => {
      if (isHintModeRunning()) {
        await stopHintMode();
        ctx.log("[hints] Hint mode OFF");
      }
      stopMapWatch();
      clearHintState();
      await getAdapter(ctx)?.clearOverlay().catch(() => undefined);
    },
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.mode",
    phrase: "hint mode",
    patterns: ["hint mode", "hints mode", "hint mode on", "hints on", "follow hints", "live hints"],
    aliases: ["hints mode", "hint mode on", "hints on", "follow hints", "live hints"],
    description: "Keep hint labels on near wherever you look (they refresh as your gaze settles somewhere new); 'hide hints' or 'hint mode off' to stop",
    repeatable: false,
    run: (ctx) => {
      if (isHintModeRunning()) {
        ctx.log("[hints] Hint mode already ON");
        return;
      }
      stopMapWatch();
      _hintMode = new HintModeController(ctx);
      _hintMode.start();
      ctx.log("[hints] Hint mode ON — labels follow your gaze; say 'click <text>', 'mouse over text 3', 'hint mode off'");
    },
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.mode-off",
    phrase: "hint mode off",
    patterns: ["hint mode off", "hints mode off", "stop hint mode", "exit hint mode"],
    aliases: ["hints mode off", "stop hint mode", "exit hint mode"],
    description: "Stop hint mode and remove the labels",
    repeatable: false,
    run: async (ctx) => {
      await stopHintMode();
      stopMapWatch();
      clearHintState();
      await getAdapter(ctx)?.clearOverlay().catch(() => undefined);
      ctx.log("[hints] Hint mode OFF");
    },
  },

  // ── Click — plain gaze click (no hint) ─────────────────────────────────────
  // "click" alone stays a gaze click. "click {hint}" routes to the hint click below.
  // NOTE: This command is defined in the gazeMouse pack. We do NOT redefine it here.
  // The hints.click-hint below handles "click <hint>" via grammar pattern.

  // ── Click with hint ─────────────────────────────────────────────────────────
  {
    ...cmd(
      "hints.click-hint",
      "click hint",
      ["click {hint:hintphrase}", "click on {hint:hintphrase}"],
      [],
      "Click a specific element by hint: 'click button 2', 'click save', 'click link 3'",
      async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "click");
      },
    ),
    // "click play a real hero" can exceed 6s audio — give click commands a larger audio cap
    maxAudioMs: 10000,
  } as VoiceCommandExtension,

  // ── Move the mouse to a hint (no click) ─────────────────────────────────────
  {
    ...cmd(
      "hints.hover-hint",
      "hover hint",
      ["hover over {hint:hintphrase}", "hover {hint:hintphrase}", "mouse over {hint:hintphrase}", "mouse to {hint:hintphrase}", "move mouse to {hint:hintphrase}", "move the mouse to {hint:hintphrase}", "move cursor to {hint:hintphrase}", "move to {hint:hint}", "point at {hint:hintphrase}"],
      [],
      "Move the mouse onto an element without clicking: 'hover button 2', 'mouse to text 3', 'move to save'",
      async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "hover");
      },
    ),
    // "mouse over hero" (A Real Hero) takes >6s to speak — give hover commands a larger audio cap
    maxAudioMs: 10000,
  } as VoiceCommandExtension,

  // ── Select / focus ──────────────────────────────────────────────────────────
  cmd(
    "hints.select-hint",
    "select hint",
    ["select {hint:hint}", "focus {hint:hint}"],
    [],
    "Focus/select a specific element: 'select input 2', 'select field', 'focus button'",
    async (ctx) => {
      const ref = hintRefFromSlots(ctx.slots);
      await findAndAct(ctx, ref, "focus");
    },
  ),

  // ── Type in a specific field (role+number or name) ──────────────────────────
  cmd(
    "hints.type-in",
    "type in hint",
    ["type in {hint:hint} {text:text}", "type {hint:hint} {text:text}"],
    [],
    "Type text into a specific field: 'type in input 2 hello world', 'type message hello'",
    async (ctx) => {
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
              adapter,
              { x: gaze.x, y: gaze.y },
              errorRadius,
              windowKey,
              { query: ref.name.split(/\s+/) },
            );
            const inputCandidates = candidates.filter((c) =>
              ["input", "select"].includes(c.roleName) &&
              (
                (c.element.title ?? "").toLowerCase().includes(ref.name!.toLowerCase()) ||
                (c.element.description ?? "").toLowerCase().includes(ref.name!.toLowerCase()) ||
                (c.displayName ?? "").toLowerCase().includes(ref.name!.toLowerCase())
              ),
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
        const joined = [ref.name, text].filter(Boolean).join(" ")
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
  ),

  // ── Bare hint (role+number only, to avoid stealing plain words) ─────────────
  // "button 2", "input 3", "link 1" alone — role MUST be present, number is required
  // to prevent single role words ("button") stealing unrelated commands.
  cmd(
    "hints.bare-hint",
    "hint",
    ["{hint:hintref}"],
    [],
    "Act on a hint by role+number alone: 'button 2', 'input 1', 'link 3'",
    async (ctx) => {
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
  ),

  // ── Links ───────────────────────────────────────────────────────────────────
  cmd(
    "hints.open-link",
    "open link hint",
    [
      "open {hint:hint} in new tab",
      "open link {hint:hint} in new tab",
      "open {hint:hint}",
      "open link {hint:hint}",
      "link {hint:hint}",
    ],
    [],
    "Open a link: 'link 3', 'open link 3', 'open link 3 in new tab'",
    async (ctx) => {
      const ref = hintRefFromSlots(ctx.slots);
      // Force role to "link" if not set
      const linkRef: HintRef = { ...ref, roleName: ref.roleName ?? "link" };
      const newTab = /\bin\s+new\s+tab\b/i.test(ctx.text);
      await findAndAct(ctx, linkRef, "click", { newTab });
    },
  ),

  // ── Checkbox ────────────────────────────────────────────────────────────────
  cmd(
    "hints.check",
    "check hint",
    ["check {hint:hint}", "toggle {hint:hint}"],
    ["check box", "check checkbox", "toggle check"],
    "Toggle a checkbox near gaze: 'check box 1', 'check 2'",
    async (ctx) => {
      const ref = hintRefFromSlots(ctx.slots);
      const checkRef: HintRef = { ...ref, roleName: ref.roleName ?? "check" };
      await findAndAct(ctx, checkRef, "check");
    },
  ),

  // ── Right click ─────────────────────────────────────────────────────────────
  cmd(
    "hints.right-click",
    "right click hint",
    ["right click {hint:hintphrase}"],
    [],
    "Right-click a hint reference: 'right click button 2', 'right click save'",
    async (ctx) => {
      const ref = hintRefFromSlots(ctx.slots);
      await findAndAct(ctx, ref, "rightClick");
    },
  ),

  // ── Navigation ──────────────────────────────────────────────────────────────
  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.next",
    phrase: "next hint",
    patterns: ["next hint", "next"],
    aliases: ["next hint"],
    description: "Move selection to the next hint candidate",
    repeatable: false,
    run: (ctx) => {
      const state = getHintState();
      if (!state || !state.candidates.length) {
        ctx.log("[hints] No hints active");
        return;
      }
      state.selectedIndex = (state.selectedIndex + 1) % state.candidates.length;
      ctx.log(`[hints] Selected: ${state.candidates[state.selectedIndex].label}`);
    },
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.previous",
    phrase: "previous hint",
    patterns: ["previous hint", "previous", "prev hint", "prev"],
    aliases: ["prev", "previous hint", "prev hint"],
    description: "Move selection to the previous hint candidate",
    repeatable: false,
    run: (ctx) => {
      const state = getHintState();
      if (!state || !state.candidates.length) {
        ctx.log("[hints] No hints active");
        return;
      }
      state.selectedIndex =
        (state.selectedIndex - 1 + state.candidates.length) % state.candidates.length;
      ctx.log(`[hints] Selected: ${state.candidates[state.selectedIndex].label}`);
    },
  },

  // ── Smart mouse ─────────────────────────────────────────────────────────────
  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.smart-mouse",
    phrase: "smart mouse",
    patterns: ["smart mouse", "magnetic cursor", "snap mouse"],
    aliases: ["magnetic cursor", "snap mouse"],
    description: "Start gaze-following mode that snaps the cursor to the nearest element",
    repeatable: false,
    run: async (ctx) => {
      if (_smartMouse?.isRunning()) {
        ctx.log("[hints] Smart mouse already running");
        return;
      }
      const adapter = getAdapter(ctx);
      if (!adapter) {
        ctx.log("[hints] No computer-use adapter available for smart mouse");
        return;
      }
      invalidateAXCache();
      _smartMouse = new SmartMouseController(
        adapter,
        () => getWindowKey(ctx),
        { errorRadius: getErrorRadius() },
      );
      _smartMouse.start();
      ctx.log("[hints] Smart mouse started — say 'stop mouse' to stop");
    },
  },

  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.stop-smart-mouse",
    phrase: "stop smart mouse",
    patterns: ["stop smart mouse"],
    aliases: [],
    description: "Stop the smart mouse gaze-follow controller",
    repeatable: false,
    run: (ctx) => {
      if (_smartMouse?.isRunning()) {
        _smartMouse.stop();
        _smartMouse = null;
        ctx.log("[hints] Smart mouse stopped");
      } else {
        ctx.log("[hints] Smart mouse was not running");
        ctx.gazeFollow?.stop();
      }
    },
  },

  // ── play <song> — AXPress the "Play <song> by …" button ─────────────────────
  // "play a real hero", "play rubber head", "click play a real hero"
  // Bare "play" and "pause" are media keys (handled elsewhere); this command
  // only fires when at least one song-name word follows "play".
  {
    ...cmd(
      "hints.play-song",
      "play song",
      [
        "play {song:songphrase}",
        "click play {song:songphrase}",
      ],
      [],
      "Play a Spotify song by name: 'play a real hero', 'click play rubber head'. Uses AXPress on the song's play button.",
      async (ctx) => {
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
          const raw = ctx.text.toLowerCase().replace(/^click\s+/, "").replace(/^play\s+/, "").trim();
          songQuery = raw.split(/\s+/).filter(Boolean);
        }
        if (!songQuery.length) {
          ctx.log("[hints] No song name provided");
          return;
        }
        ctx.log(`[hints] Looking for play button for: "${songQuery.join(" ")}"`);
        const candidate = await findPlayButton(adapter, songQuery, gaze ?? { x: 960, y: 540 });
        if (!candidate) {
          ctx.log(`[hints] No play button found for "${songQuery.join(" ")}"`);
          return;
        }
        ctx.log(`[hints] Pressing play: ${candidate.displayName ?? candidate.label}`);
        await activateElement(adapter, candidate, "click");
        _hintMode?.refreshSoon();
      },
    ),
    maxAudioMs: 12000,
  } as VoiceCommandExtension,

  // ── click that (with element memory) — AXPress the hovered element ──────────
  // After "mouse over play" or "mouse over hero", "click that" should AXPress
  // the remembered candidate, not just do a coordinate click at the pointer.
  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.click-that-element",
    phrase: "click that element",
    patterns: ["click that", "click it", "click here"],
    aliases: [],
    description: "Click the element last hovered by a 'mouse over' command, using AXPress if available",
    repeatable: false,
    run: async (ctx) => {
      const adapter = getAdapter(ctx);
      // First check if we have a remembered candidate from a recent hover
      const remembered = recentPlacedCandidate();
      if (remembered && adapter) {
        ctx.log(`[hints] click that → AXPress remembered element: ${remembered.displayName ?? remembered.label}`);
        await activateElement(adapter, remembered, "click");
        _hintMode?.refreshSoon();
        return;
      }
      // Fall back to clicking whatever is under the pointer (never the gaze point).
      await clickThat(ctx, "left");
    },
  },

  // ── double click that (with element memory) ─────────────────────────────────
  // After "mouse over <track title>", "double click that" should play the track.
  // For Spotify track rows: find and AXPress the row's "Play <song>" button.
  // For other elements: coordinate double-click at the row centre.
  {
    type: VOICE_COMMAND_EXTENSION,
    name: "hints.double-click-that-element",
    phrase: "double click that element",
    patterns: ["double click that", "double click it", "double click here"],
    aliases: [],
    description: "Double-click the element last hovered by a 'mouse over' command; for Spotify rows, uses AXPress on the row's play button",
    repeatable: false,
    run: async (ctx) => {
      const adapter = getAdapter(ctx);
      const remembered = recentPlacedCandidate();
      if (remembered && adapter) {
        ctx.log(`[hints] double click that → remembered element: ${remembered.displayName ?? remembered.label}`);
        // For AXRow elements (Spotify track rows), try to find the row's play button
        // by looking for a "Play <song>" AXButton near the row centre.
        const el = remembered.element;
        if (el.role === "AXRow" && el.bounds) {
          const rowName = el.title ?? el.description ?? "";
          // Spotify row title is like "A Real Hero  A Real Hero  …" — extract song name
          const songWords = rowName.toLowerCase().split(/\s+/).slice(0, 5).filter(Boolean);
          if (songWords.length) {
            const playBtn = await findPlayButton(adapter, songWords, {
              x: el.bounds.x + el.bounds.width / 2,
              y: el.bounds.y + el.bounds.height / 2,
            });
            if (playBtn) {
              ctx.log(`[hints] double click that → AXPress play button: ${playBtn.displayName ?? playBtn.label}`);
              await activateElement(adapter, playBtn, "click");
              _hintMode?.refreshSoon();
              return;
            }
          }
          // Fallback: double-click the row centre
          const cx = Math.round(el.bounds.x + el.bounds.width / 2);
          const cy = Math.round(el.bounds.y + el.bounds.height / 2);
          await adapter.moveMouse({ x: cx, y: cy });
          await adapter.click("left", { double: true });
          _hintMode?.refreshSoon();
          return;
        }
        // Buttons/links: one AXPress (a real double click would toggle a play
        // button twice). Anything else falls through to a real double-click at
        // the pointer the mouse-over placed.
        if (el.role === "AXButton" || el.role === "AXLink") {
          await activateElement(adapter, remembered, "click");
          _hintMode?.refreshSoon();
          return;
        }
      }
      // Fall back to coordinate double-click at the placed pointer position
      // (never the gaze point while a recent "mouse over" placement exists).
      const pos = doubleClickTarget(ctx);
      if (pos && ctx.mouse) {
        await ctx.mouse.doubleClickAt(pos.x, pos.y);
      }
    },
  },
];

// ─── registerHintSlot ────────────────────────────────────────────────────────

/**
 * Register the 'hint' slot type with core's grammar engine.
 * The slot type is already registered in grammar/slots.ts, but this function
 * exists for backward compatibility.
 */
export function registerHintSlot(): void {
  // The hint slot is pre-registered in grammar/slots.ts via registerSlotType("hint", ...)
  // Nothing extra needed here, but the function is exported for compatibility.
}
