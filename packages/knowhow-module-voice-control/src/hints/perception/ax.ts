import { taggedLogger } from "../../services/logger";
import { filterAndDedupeElements } from "../ranking";
import { ACTIONABLE_ROLES } from "../roles";
import { AX_CACHE_TTL_MS, SelectorState } from "../selectorState";
import { AXElement, ComputerUseAdapter, Rect } from "../types";

export async function getCachedElements(
  selector: SelectorState,
  adapter: ComputerUseAdapter,
  windowKey: string,
): Promise<AXElement[]> {
  const now = selector.clock.now();
  const cache = selector.axCache;
  if (cache && cache.windowKey === windowKey && now - cache.timestamp < AX_CACHE_TTL_MS) {
    return cache.elements;
  }
  // Use larger depth + element budget so deep trees (depth 16–27, e.g. media players) and Chrome
  // web content (depth up to 60) are fully captured. The Rust AX scanner
  // returns results in ~180–360 ms at these limits, within the 500 ms budget.
  // Accessibility can fail outright (e.g. "No focused accessibility
  // application" after a WindowServer restart). Never let that kill hints —
  // return an empty list so the screenshot fallback takes over.
  let rawElements: AXElement[] = [];
  try {
    rawElements = await adapter.accessibilityElements({
      interactiveOnly: false,
      maxDepth: 40,
      maxElements: 4000,
    });
  } catch (e) {
    taggedLogger("smart-selector").warn(
      `accessibility query failed (${(e as Error)?.message ?? e}); using screenshot hints only`,
    );
    return [];
  }
  // Get window bounds for viewport filtering
  let windowBounds: Rect | undefined;
  try {
    windowBounds = (await adapter.getActiveWindow?.())?.bounds ?? undefined;
  } catch { /* ignore */ }
  const elements = filterAndDedupeElements(rawElements, windowBounds);
  selector.axCache = { elements, timestamp: now, windowKey };
  return elements;
}

// ─── Chrome AX detection ─────────────────────────────────────────────────────

/** Detect if Chrome AX tree is empty/sparse and log a hint. */
export function detectChromeAXStatus(
  elements: AXElement[],
  log: (msg: string) => void,
): "ok" | "sparse" | "empty" {
  const actionable = elements.filter((el) => ACTIONABLE_ROLES.has(el.role) && el.bounds);
  if (actionable.length === 0) {
    log(
      "[smart-selector] Chrome AX tree is EMPTY — enable renderer accessibility: " +
      "launch Chrome with --force-renderer-accessibility, or visit chrome://accessibility and enable.",
    );
    return "empty";
  }
  if (actionable.length < 3) {
    log("[smart-selector] Chrome AX tree is SPARSE — may need renderer accessibility enabled.");
    return "sparse";
  }
  return "ok";
}
