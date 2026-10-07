import { GAZE_ERROR_RADIUS, GAZE_TIMEOUT } from "../gaze";
import { HintsCtx } from "./packState";
import { round } from "./geometry";
import { ComputerUseAdapter } from "./types";

// ─── Frontmost app name ───────────────────────────────────────────────────────

/** Short-TTL cache (ms): scan + publish ask back to back; the map watcher asks every few seconds. */
const FRONT_APP_MAX_AGE_MS = 1000;

export async function getFrontmostAppName(ctx: HintsCtx): Promise<string | undefined> {
  try {
    return await ctx.services.platform.frontmostApp({ maxAgeMs: FRONT_APP_MAX_AGE_MS, maxWaitMs: 2000 });
  } catch {
    return undefined;
  }
}

// ─── Resolve computer-use adapter from context ────────────────────────────────

export function getAdapter(ctx: HintsCtx): ComputerUseAdapter | null {
  return ctx.services.computer ?? null;
}

export function getWindowKey(ctx: Pick<HintsCtx, "target">): string {
  const t = ctx.target?.();
  return t ? `${Math.round(t.x / 100)}_${Math.round(t.y / 100)}` : "default";
}

export function getErrorRadius(): { x: number; y: number } {
  return { ...GAZE_ERROR_RADIUS };
}

// ─── Gaze source ──────────────────────────────────────────────────────────────

/**
 * Where to look for hints: the gaze at speech onset, else the gaze-follow
 * position, else the live gaze from the eye-tracking hub, else the mouse.
 * ("No gaze sample available" used to abort the command outright.)
 */
export async function resolveGazePoint(
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

export async function fetchLiveGaze(
  ctx: HintsCtx,
  timeoutMs: number = GAZE_TIMEOUT.fast
): Promise<{ x: number; y: number } | undefined> {
  // maxAgeMs: ignore stale samples (tracker stopped).
  const sample = await ctx.services.gaze.current({ timeoutMs, maxAgeMs: 2000 });
  return sample ? { x: sample.x, y: sample.y } : undefined;
}
