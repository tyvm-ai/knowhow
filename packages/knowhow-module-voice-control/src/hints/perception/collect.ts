import { taggedLogger } from "../../services/logger";
import { enableAXForPid, hasActionableWebContent, shouldEnableWebAX } from "../../axEnabler";
import { AppAdapterRegistry } from "../../targeting/adapter";
import { gaussianLikelihood, rankCandidates } from "../ranking";
import { ACTIONABLE_ROLES } from "../roles";
import { SelectorState } from "../selectorState";
import { AXElement, Candidate, ComputerUseAdapter, HintSource } from "../types";
import { getCachedElements } from "./ax";
import { collectVisualElements, dedupeAgainstAX } from "./visual";

// ─── Collect candidates ───────────────────────────────────────────────────────

export async function collectCandidates(
  selector: SelectorState,
  adapter: ComputerUseAdapter,
  gaze: { x: number; y: number },
  errorRadius: { x: number; y: number },
  windowKey: string,
  opts: {
    query?: string[];
    wholeWindow?: boolean;
    log?: (msg: string) => void;
    /** App name (e.g. "Google Chrome") — used for Chrome DOM fallback when AX web content is empty. */
    appName?: string;
    /** Candidate sources (default "auto"; the hints pack passes its `source` setting). */
    source?: HintSource;
    maxCandidates?: number;
    /** Screenshot scan area: around gaze (default) or the whole front window. */
    visualScan?: "gaze" | "window";
    /** Gaze scan size as a multiple of the error radius (default 2). */
    scanFactor?: number;
    /** Cache lifetime for screenshot results (default 800 ms). */
    visualTtlMs?: number;
    /** Full-window parse: label everything, number in reading order (see RankOptions.fullParse). */
    fullParse?: boolean;
    /** App adapters: extra elements (DOM), label rules and candidate filters for `appName`. */
    adapters?: AppAdapterRegistry;
  } = {},
): Promise<Candidate[]> {
  const log = opts.log ?? ((msg: string) => taggedLogger("hints").info(msg.replace(/^\[smart-selector\] /, "")));
  const source: HintSource = opts.source ?? "auto";
  const candidateFilter = opts.adapters?.filterFnFor(opts.appName);
  const rankWith = (els: AXElement[]) =>
    rankCandidates({
      gaze,
      errorRadius,
      elements: els,
      query: opts.query,
      wholeWindow: opts.wholeWindow,
      maxCandidates: opts.maxCandidates,
      fullParse: opts.fullParse,
      labelFor: opts.adapters?.labelFnFor(opts.appName),
    }).filter((c) => !candidateFilter || candidateFilter(c.element));

  if (source === "visual") {
    return rankWith(await collectVisualElements(selector, adapter, gaze, errorRadius, !!opts.wholeWindow || opts.visualScan === "window", log, opts.visualTtlMs, opts.scanFactor));
  }

  let elements = await getCachedElements(selector, adapter, windowKey);

  // Auto-enable web AX for Chromium/Electron if the tree looks sparse/empty
  if (shouldEnableWebAX(elements)) {
    let pid: number | null = null;
    try {
      pid = (await adapter.getPid?.()) ?? null;
    } catch { /* ignore */ }

    if (pid !== null) {
      const method = await enableAXForPid(pid, log);
      if (method !== "none" && method !== "failed") {
        log(`[smart-selector] Web AX enabled via ${method} for pid ${pid}; re-querying...`);
        // Invalidate cache and re-query now that accessibility is enabled
        selector.invalidateAXCache();
        elements = await getCachedElements(selector, adapter, windowKey);
        log(`[smart-selector] Re-query returned ${elements.length} elements`);
      } else {
        log(`[smart-selector] Web AX enable result: ${method} for pid ${pid}`);
      }
    } else {
      log("[smart-selector] No pid available; skipping web AX enable");
    }
  }

  // Let the front app's adapters add elements the AX tree cannot see (e.g. DOM elements).
  let effectiveElements = elements;
  if (opts.appName && opts.adapters) {
    const axLooksEmpty = !hasActionableWebContent(elements);
    for (const adapter of opts.adapters.forApp(opts.appName)) {
      if (!adapter.extraElements) continue;
      try {
        const extra = await adapter.extraElements({ elements, appName: opts.appName, axLooksEmpty, log });
        if (extra.length > 0) {
          log(`[smart-selector] ${adapter.name} adapter added ${extra.length} elements`);
          effectiveElements = [...effectiveElements, ...extra];
        }
      } catch (e) {
        log(`[smart-selector] ${adapter.name} adapter error: ${e}`);
      }
    }
  }

  if (source === "ax") return rankWith(effectiveElements);

  // Screenshot fallback: when AX/DOM give fewer than 3 actionable elements in
  // the gaze area (or always, for "both"), add OCR/box-detected elements.
  let wantVisual = source === "both";
  if (!wantVisual) {
    const near = effectiveElements.filter(
      (el) =>
        ACTIONABLE_ROLES.has(el.role) &&
        el.bounds &&
        (opts.wholeWindow || gaussianLikelihood(gaze.x, gaze.y, el.bounds, errorRadius.x, errorRadius.y) > 0.3),
    ).length;
    // A full-window parse of an app whose AX tree is thin (album grids,
    // canvas-y web apps) needs the screenshot pass to cover the rest.
    const minAx = opts.fullParse ? 25 : 3;
    wantVisual = near < minAx;
    if (wantVisual) log(`[smart-selector] Only ${near} accessible element(s) ${opts.wholeWindow ? "in window" : "near gaze"}; adding screenshot hints`);
  }
  if (wantVisual) {
    const visual = await collectVisualElements(selector, adapter, gaze, errorRadius, !!opts.wholeWindow || opts.visualScan === "window", log, opts.visualTtlMs, opts.scanFactor);
    effectiveElements = [...effectiveElements, ...dedupeAgainstAX(visual, effectiveElements, ACTIONABLE_ROLES)];
  }
  return rankWith(effectiveElements);
}

/** Run the screenshot provider over the gaze area (or whole front window). */
