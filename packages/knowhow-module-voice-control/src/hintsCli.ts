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

import { runAppleScriptSync, runJxaSync, escapeAppleScriptString } from "./actions/osa";
import { enableAXForPid } from "./axEnabler";
import { createVoiceServices } from "./services";
import { stderrSink, taggedLogger } from "./services/logger";
import { packConfigView } from "./packs/define";
import { HINTS_CONFIG } from "./hints/config";
import { collectCandidates } from "./hints/perception/collect";
import { buildHintOverlayPrimitives } from "./hints/overlay";
import { HINT_DENSITY, HintDensity } from "./hints/density";
import { Candidate, ComputerUseAdapter, HintSource } from "./hints/types";
import { SelectorState } from "./hints/selectorState";
import { GazeClient, GAZE_ERROR_RADIUS, GAZE_TIMEOUT } from "./gaze";

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

  const sample = await new GazeClient({ hubUrl: opts.hubUrl }).current({ timeoutMs: GAZE_TIMEOUT.slow });
  if (sample) return { x: sample.x, y: sample.y, source: "eye-tracker" };

  // Fall back to mouse position via JXA
  const mouse = runJxaSync(`
        ObjC.import('Cocoa');
        var loc = $.NSEvent.mouseLocation;
        var screens = $.NSScreen.screens;
        var mainHeight = $.NSScreen.mainScreen.frame.size.height;
        JSON.stringify({ x: Math.round(loc.x), y: Math.round(mainHeight - loc.y) });
      `, { timeoutMs: 3000 });
  if (mouse.ok && mouse.stdout) {
    try {
      const p = JSON.parse(mouse.stdout.trim()) as { x: number; y: number };
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        return { x: p.x, y: p.y, source: "mouse" };
      }
    } catch { /* ignore */ }
  }

  return { x: 0, y: 0, source: "unknown" };
}

// ─── Get app pid for web AX enabling ─────────────────────────────────────────

function parsePid(stdout: string): number | null {
  const pid = parseInt(stdout.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function getAppPid(appName: string): number | null {
  // Use AppleScript (System Events) — reliable, no JXA ObjC.unwrap needed.
  const direct = runAppleScriptSync(
    `tell application "System Events" to get unix id of process "${escapeAppleScriptString(appName)}"`,
    { timeoutMs: 3000 },
  );
  if (direct.ok) {
    const pid = parsePid(direct.stdout);
    if (pid) return pid;
  }
  // Fallback: list all processes and find by name prefix
  const byPrefix = runAppleScriptSync(`
tell application "System Events"
  set procs to every process whose name starts with "${escapeAppleScriptString(appName.slice(0, 10))}"
  if (count of procs) > 0 then
    return unix id of item 1 of procs
  end if
  return ""
end tell`, { timeoutMs: 3000 });
  if (byPrefix.ok) return parsePid(byPrefix.stdout);
  return null;
}

// ─── Build adapter from computer-use service ─────────────────────────────────

function frontmostPid(): number | null {
  // Use System Events to get the frontmost process pid — no JXA needed.
  const r = runAppleScriptSync(
    `tell application "System Events" to get unix id of first process whose frontmost is true`,
    { timeoutMs: 3000 },
  );
  return r.ok ? parsePid(r.stdout) : null;
}

function buildAdapter(base: ComputerUseAdapter | undefined, appName?: string): ComputerUseAdapter | null {
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
  const log = (msg: string) => taggedLogger("hints-cli", stderrSink).info(msg);

  // 1. Get gaze point
  const gaze = await getGazePoint(opts);
  if (!opts.json) {
    process.stdout.write(`Gaze: x=${gaze.x}, y=${gaze.y} (source: ${gaze.source})\n`);
  }

  // 2. Build adapter
  const services = createVoiceServices();
  const adapter = buildAdapter(services.computer, opts.app);
  if (!adapter) {
    taggedLogger("hints-cli", stderrSink).error("No computer-use adapter available. Is ComputerUse service loaded?");
    process.exit(1);
  }

  // 3. Focus app if requested
  if (opts.app) {
    try {
      runAppleScriptSync(`tell application "${escapeAppleScriptString(opts.app)}" to activate`, { timeoutMs: 3000 });
      // Wait briefly for window to come to front
      await services.clock.sleep(300);
    } catch { /* ignore */ }
  }

  // 4. Collect candidates
  const errorRadius = { ...GAZE_ERROR_RADIUS };
  const densityName: HintDensity = opts.all ? "all" : opts.density && opts.density in HINT_DENSITY ? opts.density : "normal";
  const density = HINT_DENSITY[densityName];
  const windowKey = `hints_cli_${Math.round(gaze.x / 100)}_${Math.round(gaze.y / 100)}`;

  if (!opts.json) {
    process.stdout.write(`Collecting candidates (density=${densityName})...\n`);
  }

  const selector = new SelectorState(services.clock);
  const candidates = await collectCandidates(
    selector,
    adapter,
    { x: gaze.x, y: gaze.y },
    errorRadius,
    windowKey,
    {
      wholeWindow: density.wholeWindow,
      log,
      appName: opts.app,
      adapters: services.adapters,
      source: opts.source ?? packConfigView(services, "hints", HINTS_CONFIG).source,
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
      visualTimings: selector.visual.lastTimings ?? null,
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
          await services.clock.sleep(700);
        }
      } else {
        if (!opts.json) {
          process.stdout.write("\nOverlay shown for 4s...\n");
        }
        await services.clock.sleep(4000);
      }
      await adapter.clearOverlay();
    } catch (e) {
      if (!opts.json) {
        taggedLogger("hints-cli", stderrSink).error(`Overlay error: ${e}`);
      }
    }
  }
}
