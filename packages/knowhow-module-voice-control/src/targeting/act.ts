/**
 * The click family as thin calls: resolve the target, let the front app's
 * adapter take over if it wants to, otherwise do the generic mouse action.
 */

import type { PackCommandContext } from "../packs/define";
import type { Target, ResolveHints, TargetAction } from "./resolver";

export type ClickAction = "click" | "doubleClick" | "rightClick";

/** True when the utterance ends in "that" / "it" / "here" / "there". */
export function isDeicticClick(text: string | undefined): boolean {
  return /\b(?:that|it|here|there)\s*[.!?]*\s*$/i.test(text ?? "");
}

/** Which app should handle `target`: the app the pointer was placed in, else the front app. */
async function appFor(ctx: PackCommandContext, target: Target): Promise<string | undefined> {
  if (target.app) return target.app;
  try {
    return await ctx.services.platform.frontmostApp({ maxAgeMs: 1000, maxWaitMs: 800 });
  } catch {
    return undefined;
  }
}

/** Offer a remembered element to the front app's adapters. True when one handled it. */
async function tryAdapters(ctx: PackCommandContext, target: Target, action: "click" | "doubleClick"): Promise<boolean> {
  if (!target.element) return false;
  const app = await appFor(ctx, target);
  for (const adapter of ctx.services.adapters.forApp(app)) {
    if (!adapter.activate) continue;
    try {
      if (await adapter.activate(target, action, ctx.services)) return true;
    } catch (e) {
      ctx.services.log.child("targeting").debug(`adapter ${adapter.name} failed: ${e}`);
    }
  }
  return false;
}

/**
 * Resolve + act. `that: true` ("click that", "double click that …") acts on
 * what "mouse over" last pointed at: adapters get the remembered element first
 * (double click), plain click clicks in place. Returns the target that was used.
 */
export async function performClick(
  ctx: PackCommandContext,
  action: ClickAction,
  hints: ResolveHints = {}
): Promise<Target | undefined> {
  const mouse = ctx.mouse;
  if (!mouse) return undefined;
  const { targets } = ctx.services;

  // "click that" clicks in place — the pointer is already on the thing you mean.
  if (hints.that && action === "click" && mouse.clickHere) {
    await mouse.clickHere("left");
    return undefined;
  }

  const target = await targets.resolve(ctx, action as TargetAction, hints);
  if (!target) return undefined;

  if (hints.that && action === "doubleClick" && (await tryAdapters(ctx, target, "doubleClick"))) return target;

  if (action === "doubleClick") await mouse.doubleClickAt(target.point.x, target.point.y);
  else await mouse.clickAt(target.point.x, target.point.y, action === "rightClick" ? "right" : "left");
  return target;
}
