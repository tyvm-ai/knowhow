/**
 * "double click" behaviour (one command: `voice-control.double-click`).
 *
 * - Plain "double click": double-click the pointer a "mouse over X" placed
 *   (never the gaze point while that placement is recent), else the gaze point.
 * - Deictic forms ("double click that / it / here / there"): first act on the
 *   element the last "mouse over" hovered — Spotify rows press their play
 *   button, buttons/links get one AXPress (a real double click would toggle a
 *   play button twice), anything else gets a real double-click at the pointer.
 */

import type { PackCommandContext } from "../packs/define";
import { activateElement, findPlayButton } from "../smartSelector";

/** True when the utterance ends in "that" / "it" / "here" / "there". */
export function isDeicticClick(text: string | undefined): boolean {
  return /\b(?:that|it|here|there)\s*[.!?]*\s*$/i.test(text ?? "");
}

/** Act on the remembered "mouse over" element. Returns true when it handled the click. */
async function doubleClickRememberedElement(ctx: PackCommandContext): Promise<boolean> {
  const remembered = ctx.services.pointer.recentCandidate();
  if (!remembered) return false;
  try {
    const cu = ctx.services.computer;
    if (!cu) return false;
    const el = remembered.element;
    // Spotify AXRow: find and AXPress the row's play button.
    if (el.role === "AXRow" && el.bounds) {
      const rowName = (el.title ?? el.description ?? "").toLowerCase();
      const songWords = rowName.split(/\s+/).slice(0, 6).filter(Boolean);
      if (songWords.length) {
        const playBtn = await findPlayButton(cu, songWords, {
          x: el.bounds.x + el.bounds.width / 2,
          y: el.bounds.y + el.bounds.height / 2,
        });
        if (playBtn) {
          await activateElement(cu, playBtn, "click", { pointer: ctx.services.pointer, clock: ctx.services.clock });
          return true;
        }
      }
      // Fallback: double-click the row centre.
      const cx = Math.round(el.bounds.x + el.bounds.width / 2);
      const cy = Math.round(el.bounds.y + el.bounds.height / 2);
      await cu.moveMouse({ x: cx, y: cy });
      await cu.click("left", { double: true });
      return true;
    }
    // Buttons/links: one AXPress is the "open/play".
    if (el.role === "AXButton" || el.role === "AXLink") {
      await activateElement(cu, remembered, "click", { pointer: ctx.services.pointer, clock: ctx.services.clock });
      return true;
    }
  } catch {
    /* fall through to the coordinate double-click */
  }
  return false;
}

export async function runDoubleClick(ctx: PackCommandContext): Promise<void> {
  if (isDeicticClick(ctx.text) && (await doubleClickRememberedElement(ctx))) return;
  // A recent "mouse over X" put the pointer on X: double-click there, even if
  // your eyes have moved on. Only otherwise use the gaze point.
  const pos = ctx.services.pointer.doubleClickTarget(ctx);
  if (pos && ctx.mouse) await ctx.mouse.doubleClickAt(pos.x, pos.y);
}
