/**
 * How many hints to show. "few" keeps only the closest handful, "normal" is a
 * gaze-centred scan, "more" widens it, and "all" (the default) parses the whole
 * front window and labels every actionable element found.
 */
export type HintDensity = "few" | "normal" | "more" | "all";

/** Upper bound on labels for a full-window parse (effectively "everything"). */
export const FULL_PARSE_MAX_LABELS = 600;

export const HINT_DENSITY: Record<HintDensity, { labels: number; scanFactor: number; wholeWindow: boolean; full?: boolean }> = {
  few: { labels: 6, scanFactor: 1.5, wholeWindow: false },
  normal: { labels: 15, scanFactor: 2, wholeWindow: false },
  more: { labels: 30, scanFactor: 3, wholeWindow: false },
  // Full parse of the front window: every actionable element gets a label.
  all: { labels: FULL_PARSE_MAX_LABELS, scanFactor: 2, wholeWindow: true, full: true },
};

// Hints stay up until "hide hints" / "hide map" (no timeout). A new "hints" /
// "map" redraws them. Labels stay on screen exactly as long as their numbers
// are valid, so a visible "text 11" always means the element it is drawn on.
export const HINT_STATE_TTL_MS = Number.POSITIVE_INFINITY;
export const HINT_OVERLAY_MS = HINT_STATE_TTL_MS;
