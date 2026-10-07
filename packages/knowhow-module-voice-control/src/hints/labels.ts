import { rectOverlapFrac } from "./geometry";
import { AXElement, Candidate, Rect } from "./types";

// ─── Rank candidates ──────────────────────────────────────────────────────────

/**
 * Sort items top→bottom, left→right. Items whose vertical centres are within
 * `lineTolerance` px of the current line's first item share a line, so a row of
 * album cards or the cells of one email get consecutive numbers.
 */
export function sortReadingOrder<T>(items: T[], rectOf: (t: T) => Rect, lineTolerance = 12): T[] {
  const cy = (t: T) => { const r = rectOf(t); return r.y + r.height / 2; };
  const byY = [...items].sort((a, b) => cy(a) - cy(b));
  const out: T[] = [];
  let line: T[] = [];
  let lineY = 0;
  const flush = () => {
    line.sort((a, b) => rectOf(a).x - rectOf(b).x);
    out.push(...line);
    line = [];
  };
  for (const t of byY) {
    if (line.length && Math.abs(cy(t) - lineY) > lineTolerance) flush();
    if (!line.length) lineY = cy(t);
    line.push(t);
  }
  flush();
  return out;
}

// ─── Short display name derivation ───────────────────────────────────────────

/**
 * Derive a short matchable display name from AX element name fields.
 *
 * Generic patterns:
 *   "Add to Liked Songs" → "add to liked songs"
 *   "120 Likes. Like" → "like" (verb after last ". ")
 *   "32 Replies. Reply" → "reply"
 *   "28 reposts. Repost" → "repost"
 *   "Share post" → "share post"
 *   "Bookmark" → "bookmark"
 *
 * App-specific label rules ("Play X by Y" → "play x") come from an AppAdapter's
 * `labelFor`, passed as `labelFor`; its answer wins over the generic fallback.
 *
 * Returns a lowercase string of <= 40 chars, suitable for fuzzy matching.
 */
export function deriveShortName(el: AXElement, labelFor?: (el: AXElement) => string | undefined): string {
  const raw = (el.title || el.description || el.value || "").trim();
  if (!raw) return "";

  // "N Likes. Like", "N Replies. Reply", "N reposts. Repost"
  // Extract the action word after the last ". "
  const dotSplit = raw.split(". ");
  if (dotSplit.length >= 2) {
    const last = dotSplit[dotSplit.length - 1].trim();
    // e.g. "Like", "Reply", "Repost"
    if (last && last.split(/\s+/).length <= 3) {
      return last.toLowerCase();
    }
  }

  const appLabel = labelFor?.(el);
  if (appLabel !== undefined) return appLabel;

  // "Add to Liked Songs" → keep as-is (short enough)
  return raw.toLowerCase().slice(0, 40);
}

// ─── Stable / unique labels ──────────────────────────────────────────────────

function sameTarget(a: Candidate, b: Candidate): boolean {
  const ra = a.element.bounds, rb = b.element.bounds;
  if (!ra || !rb || a.roleName !== b.roleName) return false;
  if ((a.displayName ?? "") !== (b.displayName ?? "")) return false;
  const dx = Math.abs(ra.x + ra.width / 2 - (rb.x + rb.width / 2));
  const dy = Math.abs(ra.y + ra.height / 2 - (rb.y + rb.height / 2));
  return (dx <= 16 && dy <= 16) || rectOverlapFrac(ra, rb) > 0.6;
}

/**
 * Relabel `next` so an element that was already labelled in `prev` keeps its
 * number ("text 11" stays "text 11" across hint-mode refreshes), and new
 * elements take the lowest number not used by a kept one. Labels in the
 * result are always unique. Order (ranking) is unchanged.
 */
export function stabilizeLabels(prev: Candidate[] | undefined, next: Candidate[]): Candidate[] {
  const used = new Map<string, Set<number>>();
  const take = (role: string, n: number) => {
    if (!used.has(role)) used.set(role, new Set());
    used.get(role)!.add(n);
  };
  const isUsed = (role: string, n: number) => !!used.get(role)?.has(n);
  const assigned: Array<number | undefined> = next.map(() => undefined);
  if (prev?.length) {
    const claimed = new Set<Candidate>();
    next.forEach((c, i) => {
      const match = prev.find((p) => !claimed.has(p) && sameTarget(p, c) && !isUsed(c.roleName, p.roleIndex));
      if (match) {
        claimed.add(match);
        assigned[i] = match.roleIndex;
        take(c.roleName, match.roleIndex);
      }
    });
  }
  return next.map((c, i) => {
    let idx = assigned[i];
    if (idx === undefined) {
      idx = 1;
      while (isUsed(c.roleName, idx)) idx++;
      take(c.roleName, idx);
    }
    return { ...c, roleIndex: idx, label: `${c.roleName} ${idx}` };
  });
}

/** Labels that appear more than once (should always be empty). */
export function duplicateLabels(candidates: Candidate[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const c of candidates) (seen.has(c.label) ? dups : seen).add(c.label);
  return [...dups];
}
