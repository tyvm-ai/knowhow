import { getAdapter, resolveGazePoint } from "./context";
import { HintDensity } from "./density";
import { density } from "./packState";
import { isHintModeRunning } from "./hintMode";
import { MapSpec, MapWatcher, drawMap, scanMap, stopMapWatch } from "./map";
import { HintsCtx } from "./packState";
import { detectChromeAXStatus } from "./perception/ax";

// ─── Shared show-hints logic ──────────────────────────────────────────────────

export async function showHintsNear(ctx: HintsCtx, mode: boolean | HintDensity, query?: string[]): Promise<void> {
  const level: HintDensity = mode === true ? "all" : mode === false ? density(ctx.state, ctx.config.density) : mode;
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
