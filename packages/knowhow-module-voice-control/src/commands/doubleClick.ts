/**
 * "double click" behaviour (one command: `voice-control.double-click`).
 *
 * - Plain "double click": double-click the pointer a "mouse over X" placed
 *   (never the gaze point while that placement is recent), else the gaze point.
 * - Deictic forms ("double click that / it / here / there"): first offer the
 *   element the last "mouse over" hovered to the front app's adapter (e.g. a
 *   music app presses a row's play button), else a real double-click at the pointer.
 *
 * Targeting is the TargetResolver's `doubleClick` policy; app specifics live in `adapters/`.
 */

import type { PackCommandContext } from "../packs/define";
import { isDeicticClick, performClick } from "../targeting/act";

export { isDeicticClick } from "../targeting/act";

export async function runDoubleClick(ctx: PackCommandContext): Promise<void> {
  await performClick(ctx, "doubleClick", { that: isDeicticClick(ctx.text) });
}
