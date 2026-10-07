import { GazeClient } from "../gaze";
import { Clock, systemClock } from "../services/clock";
import { PointerMemory } from "../services/pointer";
import { round } from "./geometry";
import { Candidate, ComputerUseAdapter } from "./types";

// ─── Gaze correction POST ──────────────────────────────────────────────────

export async function postGazeCorrection(
  target: { x: number; y: number },
  hubUrl?: string,
): Promise<void> {
  await new GazeClient({ hubUrl }).correct(target);
}

// ─── Element actions ──────────────────────────────────────────────────────────

/**
 * Re-query the AX tree and find an element matching the original by
 * role + name + approx bounds (centre within 30px). Used when the stored
 * element ID may have gone stale after layout changes.
 */
async function resolveStaleElement(
  adapter: ComputerUseAdapter,
  candidate: Candidate,
): Promise<Candidate> {
  try {
    const fresh = await adapter.accessibilityElements({
      interactiveOnly: false,
      maxDepth: 40,
      maxElements: 4000,
    });
    const el = candidate.element;
    const ob = el.bounds;
    const name = (el.title ?? el.description ?? el.value ?? "").toLowerCase();
    const role = el.role;
    const found = fresh.find((f) => {
      if (f.role !== role) return false;
      const fname = (f.title ?? f.description ?? f.value ?? "").toLowerCase();
      if (fname !== name) return false;
      if (ob && f.bounds) {
        const ocx = ob.x + ob.width / 2;
        const ocy = ob.y + ob.height / 2;
        const fcx = f.bounds.x + f.bounds.width / 2;
        const fcy = f.bounds.y + f.bounds.height / 2;
        return Math.hypot(fcx - ocx, fcy - ocy) <= 30;
      }
      return true;
    });
    if (found) {
      return { ...candidate, element: found };
    }
  } catch {
    // ignore — use original
  }
  return candidate;
}

export async function activateElement(
  adapter: ComputerUseAdapter,
  candidate: Candidate,
  action: "click" | "focus" | "check" | "rightClick" = "click",
  deps: { pointer?: PointerMemory; clock?: Clock; app?: string } = {},
): Promise<void> {
  const clock = deps.clock ?? systemClock;
  let resolvedCandidate = candidate;
  let el = candidate.element;
  const bounds = el.bounds;

  if (action === "click" || action === "check") {
    // Prefer AXPress for AX-sourced elements. Before pressing, re-query to
    // handle stale tree paths (layout changes after hover/scroll can invalidate
    // the cached id). VX* pseudo-roles are visual-only — no re-query needed.
    if (el.actions.includes("AXPress")) {
      if (el.id && !el.role.startsWith("VX")) {
        resolvedCandidate = await resolveStaleElement(adapter, candidate);
        el = resolvedCandidate.element;
      }
      await adapter.performAccessibilityAction(el.id, "AXPress");
    } else if (bounds) {
      const cx = Math.round(bounds.x + bounds.width / 2);
      const cy = Math.round(bounds.y + bounds.height / 2);
      await adapter.moveMouse({ x: cx, y: cy });
      // Let the page see the hover first; web apps (X profile links, menus)
      // can ignore a click that arrives in the same instant as the move.
      await clock.sleep(60);
      await adapter.click("left");
      deps.pointer?.notePlaced({ x: cx, y: cy }, resolvedCandidate, deps.app);
    }
    if (bounds) {
      await postGazeCorrection({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    }
  } else if (action === "focus") {
    // Try AXRaise or AXFocused for inputs
    if (el.actions.includes("AXRaise")) {
      await adapter.performAccessibilityAction(el.id, "AXRaise");
    } else if (bounds) {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      await adapter.moveMouse({ x: cx, y: cy });
      await adapter.click("left");
    }
    if (bounds) {
      await postGazeCorrection({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    }
  } else if (action === "rightClick") {
    if (bounds) {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      await adapter.moveMouse({ x: cx, y: cy });
      await adapter.click("right");
      await postGazeCorrection({ x: cx, y: cy });
    }
  }
}
