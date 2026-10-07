/**
 * hintsCli.ts — Dry-run CLI for `knowhow voice-control hints`
 *
 * Usage:
 *   knowhow voice-control hints [--json] [--x N --y N] [--all] [--app NAME]
 *                              [--source auto|ax|visual|both] [--move]
 *
 *   --source visual  use only screenshot detection (OCR + box segmentation),
 *                    which works without Chrome accessibility
 *   --density        few|normal|more|all — how many labels / how wide (default normal)
 *   --move           after listing, move the mouse to each labelled hint in
 *                    turn (0.7 s each) to check the targets line up
 *
 * Behaviour:
 *  1. Get gaze from eye tracker (http://127.0.0.1:7465/api/gaze) or fall back
 *     to mouse position / given --x --y.
 *  2. If --app is set, focus that window first.
 *  3. Collect + rank candidates using collectCandidates (which auto-enables
 *     web AX for Chrome/Electron if needed).
 *  4. Print label, role, name, frame, score (or JSON).
 *  5. Show the hint overlay for 4 s via the existing overlay helpers.
 */

import { spawnSync } from "child_process";
import { enableAXForPid } from "./axEnabler";
import { getComputerService } from "./computerService";
import {
  collectCandidates,
  buildHintOverlayPrimitives,
  HINT_DENSITY,
  HintDensity,
  Candidate,
  ComputerUseAdapter,
  HintSource,
} from "./smartSelector";
import { lastVisualTimings } from "./visualElements";

export interface HintsCliOptions {
  json?: boolean;
  x?: number;
  y?: number;
  all?: boolean;
  app?: string;
  hubUrl?: string;
  source?: HintSource;
  move?: boolean;
  density?: HintDensity;
}

// ─── Get gaze from eye tracker or mouse ──────────────────────────────────────

async function getGazePoint(
  opts: HintsCliOptions,
): Promise<{ x: number; y: number; source: string }> {
  if (opts.x !== undefined && opts.y !== undefined) {
    return { x: opts.x, y: opts.y, source: "cli" };
  }

  const hubUrl = opts.hubUrl ?? "http://127.0.0.1:7465";
  try {
    const res = await fetch(`${hubUrl}/api/gaze`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = (await res.json()) as { x?: number; y?: number };
      if (Number.isFinite(data.x) && Number.isFinite(data.y)) {
        return { x: data.x!, y: data.y!, source: "eye-tracker" };
      }
    }
  } catch { /* fall through */ }

  // Fall back to mouse position via osascript
  try {
    const result = spawnSync(
      "osascript",
      ["-l", "JavaScript", "-e", `
        ObjC.import('Cocoa');
        var loc = $.NSEvent.mouseLocation;
        var screens = $.NSScreen.screens;
        var mainHeight = $.NSScreen.mainScreen.frame.size.height;
        JSON.stringify({ x: Math.round(loc.x), y: Math.round(mainHeight - loc.y) });
      `],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status === 0 && result.stdout) {
      const p = JSON.parse(result.stdout.trim()) as { x: number; y: number };
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return { x: p.x, y: p.y, source: "mouse" };
      }
    }
  } catch { /* ignore */ }

  return { x: 0, y: 0, source: "unknown" };
}

// ─── Get app pid for web AX enabling ─────────────────────────────────────────

function getAppPid(appName: string): number | null {
  // Use AppleScript (System Events) — reliable, no JXA ObjC.unwrap needed.
  try {
    const result = spawnSync(
      "osascript",
      ["-e", `tell application "System Events" to get unix id of process "${appName}"`],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status === 0 && result.stdout?.trim()) {
      const pid = parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch { /* ignore */ }
  // Fallback: list all processes and find by name prefix
  try {
    const result = spawnSync(
      "osascript",
      ["-e", `
tell application "System Events"
  set procs to every process whose name starts with "${appName.slice(0, 10)}"
  if (count of procs) > 0 then
    return unix id of item 1 of procs
  end if
  return ""
end tell`],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status === 0 && result.stdout?.trim()) {
      const pid = parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Build adapter from computer-use service ─────────────────────────────────

function frontmostPid(): number | null {
  // Use System Events to get the frontmost process pid — no JXA needed.
  try {
    const result = spawnSync(
      "osascript",
      ["-e", `tell application "System Events" to get unix id of first process whose frontmost is true`],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status === 0 && result.stdout?.trim()) {
      const pid = parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch { /* ignore */ }
  return null;
}

function buildAdapter(appName?: string): ComputerUseAdapter | null {
  const base = getComputerService();
  if (!base) return null;
  // Object.create keeps the service's prototype methods (a spread would drop them).
  const adapter = Object.create(base) as ComputerUseAdapter & { getPid?: () => Promise<number | null> };
  adapter.getPid = async () => (appName ? getAppPid(appName) : frontmostPid());
  return adapter;
}

// ─── Print helpers ────────────────────────────────────────────────────────────

function formatCandidate(c: Candidate, index: number): string {
  const b = c.element.bounds;
  const frame = b ? `[${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}]` : "(no frame)";
  const name = c.displayName ?? c.element.title ?? c.element.description ?? "";
  return `  ${index + 1}. ${c.label.padEnd(12)} role=${c.element.role.replace(/^AX/, "").padEnd(14)} score=${c.score.toFixed(3)}  ${frame}  ${name ? `"${name}"` : ""}`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runHintsCli(opts: HintsCliOptions = {}): Promise<void> {
  const log = (msg: string) => process.stderr.write(msg + "\n");

  // 1. Get gaze point
  const gaze = await getGazePoint(opts);
  if (!opts.json) {
    process.stdout.write(`Gaze: x=${gaze.x}, y=${gaze.y} (source: ${gaze.source})\n`);
  }

  // 2. Build adapter
  const adapter = buildAdapter(opts.app);
  if (!adapter) {
    process.stderr.write("[hints-cli] No computer-use adapter available. Is ComputerUse service loaded?\n");
    process.exit(1);
  }

  // 3. Focus app if requested
  if (opts.app) {
    try {
      const focusScript = `
        tell application "${opts.app}" to activate
      `;
      spawnSync("osascript", ["-e", focusScript], { timeout: 3000 });
      // Wait briefly for window to come to front
      await new Promise((r) => setTimeout(r, 300));
    } catch { /* ignore */ }
  }

  // 4. Collect candidates
  const errorRadius = { x: 200, y: 260 };
  const densityName: HintDensity = opts.all ? "all" : opts.density && opts.density in HINT_DENSITY ? opts.density : "normal";
  const density = HINT_DENSITY[densityName];
  const windowKey = `hints_cli_${Math.round(gaze.x / 100)}_${Math.round(gaze.y / 100)}`;

  if (!opts.json) {
    process.stdout.write(`Collecting candidates (density=${densityName})...\n`);
  }

  const candidates = await collectCandidates(
    adapter,
    { x: gaze.x, y: gaze.y },
    errorRadius,
    windowKey,
    {
      wholeWindow: density.wholeWindow,
      log,
      appName: opts.app,
      source: opts.source,
      scanFactor: density.scanFactor,
      maxCandidates: Math.max(20, density.labels),
      fullParse: !!density.full,
    },
  );
  const maxLabels = density.labels;

  // 5. Output results
  if (opts.json) {
    const output = {
      gaze,
      source: opts.source ?? "auto",
      visualTimings: lastVisualTimings ?? null,
      count: candidates.length,
      candidates: candidates.map((c) => ({
        label: c.label,
        role: c.element.role,
        name: c.element.title ?? c.element.description ?? c.element.value ?? null,
        score: c.score,
        frame: c.element.bounds ?? null,
        displayName: c.displayName ?? null,
      })),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    process.stdout.write(`\nFound ${candidates.length} candidates:\n`);
    if (candidates.length === 0) {
      process.stdout.write("  (none — try --all to search whole window, or enable Chrome accessibility)\n");
    } else {
      for (let i = 0; i < candidates.length; i++) {
        process.stdout.write(formatCandidate(candidates[i], i) + "\n");
      }
    }
  }

  // 6. Show overlay for 4s
  if (candidates.length > 0) {
    try {
      const primitives = buildHintOverlayPrimitives(candidates, maxLabels);
      await adapter.showOverlay(primitives);
      if (opts.move) {
        // Visit each labelled hint so you can see the mouse land on it.
        for (const c of candidates.slice(0, maxLabels)) {
          const b = c.element.bounds;
          if (!b) continue;
          const p = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
          if (!opts.json) process.stdout.write(`  → ${c.label}${c.displayName ? ` "${c.displayName}"` : ""} at ${p.x},${p.y}\n`);
          await adapter.moveMouse(p);
          await new Promise((r) => setTimeout(r, 700));
        }
      } else {
        if (!opts.json) {
          process.stdout.write("\nOverlay shown for 4s...\n");
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
      await adapter.clearOverlay();
    } catch (e) {
      if (!opts.json) {
        process.stderr.write(`[hints-cli] Overlay error: ${e}\n`);
      }
    }
  }
}
