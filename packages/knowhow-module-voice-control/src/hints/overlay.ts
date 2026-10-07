import { SelectorState } from "./selectorState";
import { Candidate, ComputerUseAdapter, OverlayPrimitive } from "./types";

// ─── Overlay helpers ──────────────────────────────────────────────────────────

/** Hint overlays persist until cleared ("hide hints"); pass a finite ttl to auto-clear. */
const HINT_OVERLAY_TTL_MS = Number.POSITIVE_INFINITY;

interface LabelBox { x: number; y: number; w: number; h: number }

/** Bright, mutually distinct colours for hint outlines + their tags. */
const HINT_PALETTE = ["#FFD700", "#00E5FF", "#FF5CCB", "#7CFF4F", "#FF9F1C", "#B69CFF"];

function boxesHit(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Build overlay primitives for the current candidates: a thin outline per
 * element plus a readable tag (dark pill + bold text). Names are included
 * only when few labels are shown, to keep dense pages legible. Tags try
 * above-left, inside-left and below-left positions to avoid colliding.
 */
export function buildHintOverlayPrimitives(candidates: Candidate[], maxLabels = 9): OverlayPrimitive[] {
  const shown = candidates.filter((c) => c.element.bounds).slice(0, maxLabels);
  const withNames = shown.length <= 9;
  const fontSize = shown.length > 20 ? 12 : 13;
  const charW = fontSize * 0.62;
  const tagH = fontSize + 6;
  const outlines: OverlayPrimitive[] = [];
  const tags: OverlayPrimitive[] = [];
  const placed: LabelBox[] = [];
  shown.forEach((c, i) => {
    const { x, y, width, height } = c.element.bounds!;
    // Each element's outline and tag share a colour, so it's obvious which box
    // a number belongs to even when a tag sits next to a neighbouring box.
    const color = HINT_PALETTE[i % HINT_PALETTE.length];
    outlines.push({ kind: "rect", x, y, width, height, color: `${color}CC`, lineWidth: shown.length > 20 ? 1 : 2 });
    const labelText = withNames && c.displayName ? `${c.label}: ${c.displayName}` : c.label;
    const w = Math.ceil(labelText.length * charW) + 8;
    // Inside the box first (unambiguous) when it fits; above it otherwise.
    const fitsInside = height >= tagH + 2 && width >= w + 2;
    const options: LabelBox[] = [
      ...(fitsInside ? [{ x: x + 1, y: y + 1, w, h: tagH }] : []), // inside, top-left
      { x, y: y - tagH - 1, w, h: tagH }, // above
      { x: x + 1, y: y + Math.max(0, (height - tagH) / 2), w, h: tagH }, // inside, left
      { x, y: y + height + 1, w, h: tagH }, // below
      { x: x - w - 2, y: y + (height - tagH) / 2, w, h: tagH }, // left of element
    ];
    const box = options.find((o) => o.y >= 0 && !placed.some((p) => boxesHit(o, p))) ?? options[fitsInside ? 0 : 1];
    placed.push(box);
    const midY = box.y + box.h / 2;
    // Rounded dark backing: a thick round-capped line acts as a filled pill.
    tags.push({
      kind: "line",
      x: box.x + tagH / 2,
      y: midY,
      x2: box.x + box.w - tagH / 2,
      y2: midY,
      color: "#000000D9",
      lineWidth: Math.min(32, tagH),
    });
    tags.push({ kind: "text", x: box.x + 4, y: box.y + 2, text: labelText, fontSize, color });
  });
  // Outlines first so tags draw on top of neighbouring outlines.
  return [...outlines, ...tags];
}

export async function showHintOverlay(
  selector: SelectorState,
  adapter: ComputerUseAdapter,
  candidates: Candidate[],
  ttlMs = HINT_OVERLAY_TTL_MS,
  maxLabels = 9,
): Promise<void> {
  const primitives = buildHintOverlayPrimitives(candidates, maxLabels);
  if (selector.overlayClearTimer) selector.clock.clearTimeout(selector.overlayClearTimer);
  await adapter.showOverlay(primitives);
  selector.overlayClearTimer = undefined;
  if (!Number.isFinite(ttlMs)) return;
  // Auto-clear after TTL (a newer overlay cancels the older timer).
  selector.overlayClearTimer = selector.clock.setTimeout(() => {
    selector.overlayClearTimer = undefined;
    adapter.clearOverlay().catch(() => undefined);
  }, ttlMs);
  selector.overlayClearTimer.unref?.();
}
