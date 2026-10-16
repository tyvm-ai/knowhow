import { centerOf } from "../targeting/resolver";
import { activateElement, postGazeCorrection } from "./activate";
import { getAdapter, getErrorRadius, getFrontmostAppName, getWindowKey, resolveGazePoint } from "./context";
import { HINT_DENSITY, HINT_OVERLAY_MS } from "./density";
import { density } from "./packState";
import { isHintModeRunning } from "./hintMode";
import { publishHints } from "./map";
import { showHintOverlay } from "./overlay";
import { HintsCtx } from "./packState";
import { collectCandidates } from "./perception/collect";
import { center } from "./perception/visual";
import { isAmbiguous } from "./ranking";
import { HintRef, resolveHintRef } from "./refs";
import { showHintsNear } from "./show";
import { Candidate, ComputerUseAdapter } from "./types";

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
  const labels = HINT_DENSITY[density(ctx.state, ctx.config.density)].labels;
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
      source: ctx.config.source,
      wholeWindow: !!HINT_DENSITY[density(ctx.state, ctx.config.density)].full,
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
      HINT_DENSITY[density(ctx.state, ctx.config.density)].labels,
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

export async function findAndAct(ctx: HintsCtx, ref: HintRef, action: HintAction, extra?: HintActionOptions): Promise<void> {
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
