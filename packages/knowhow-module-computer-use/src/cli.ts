import * as fs from "fs";
import type { Command } from "commander";
import { ComputerService } from "./ComputerService";
import { RustCoreDriver } from "./drivers/RustCoreDriver";
import { parseMacroFile, runMacro } from "./macro";
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import { COMPUTER_USE_PROMPT } from "./prompt";
import {
  AutomationRunner,
  AutomationSpec,
  loadAutomation,
  listAutomations,
  saveAutomation,
  validateScript,
} from "./automation";
import { parsePlatforms, registerFiletype, writeLaunchers } from "./launcher";
import {
  listRegions,
  getRegion,
  getStoredRegion,
  isWindowRelativeRegion,
} from "./regions";
import { storedBounds, isRegionShape, toShape } from "./regionShape";
import * as hostOps from "./host/hostOps";
import { ensureHost, hostBinaryPath, probeHost } from "./host/hostLauncher";
import { ExtensionsService } from "@tyvm/knowhow/ts_build/src/services/ExtensionsService";

/**
 * Register `knowhow computer <verb>` CLI subcommands on the passed Program.
 *
 * The CLI builds its own ComputerService (with the Rust core registered) rather
 * than depending on the full services graph, so `knowhow computer doctor` and
 * friends work standalone during the early CLI phase.
 */
export interface ComputerCliOptions {
  /** Preselected models good at computer use, chosen by config or defaults. */
  agentModel?: string;
  agentProvider?: string;
  agentName?: string;
}

export function registerComputerCli(
  program: Command,
  cliOpts: ComputerCliOptions = {}
): void {
  // Avoid double-registration if register() runs more than once.
  const existing = (program.commands || []).some(
    (c: any) => c.name && c.name() === "computer"
  );
  if (existing) return;

  const buildService = (driverName?: string): ComputerService => {
    const svc = new ComputerService({ driver: driverName });
    const rust = RustCoreDriver.tryLoad();
    if (rust) svc.registerDriver(rust);
    return svc;
  };

  const cmd = program
    .command("computer")
    .description("Cross-platform computer-use (mouse/keyboard/screen) commands");

  cmd
    .command("doctor")
    .description("Report computer-use driver availability and permissions.")
    .option("--driver <name>", "Pin a driver by name")
    .option("--fix", "Open System Settings to grant Screen Recording / Accessibility permission")
    .action(async (opts) => {
      const svc = buildService(opts.driver);
      const drivers = svc.listDrivers();
      console.log(`Registered drivers: ${drivers.join(", ") || "(none)"}`);
      try {
        const driver = await svc.getDriver();
        const caps = await driver.capabilities();
        console.log(`Active driver: ${driver.name}`);
        console.log(`Capabilities: ${JSON.stringify(caps)}`);

        const missingCapture = !caps.capture;
        const missingInput = !caps.input;

        if (missingCapture || missingInput) {
          console.log("\n⚠️  Missing permissions detected.");
          console.log(`Node binary: ${process.execPath}`);
          console.log(`\nℹ️  knowhow now runs directly as a child of your terminal (no double-wrapping).`);
          console.log(`   macOS grants Screen Recording to the *terminal app*, so grant permission to`);
          console.log(`   Ghostty (or your terminal) — NOT node itself — for the most secure setup.`);
          if (missingCapture) {
            console.log("\nTo fix Screen Recording permission:");
            console.log("  System Settings → Privacy & Security → Screen Recording");
            console.log("  Enable your terminal app (e.g. Ghostty) in the list.");
            console.log("  If Ghostty is not listed, click '+' and add it from /Applications.");
            console.log(`  (To grant node directly instead: ${process.execPath})`);
          }
          if (missingInput) {
            console.log("\nTo fix Accessibility permission:");
            console.log("  System Settings → Privacy & Security → Accessibility");
            console.log("  Enable your terminal app (e.g. Ghostty) in the list.");
            console.log(`  (To grant node directly instead: ${process.execPath})`);
          }
          if (opts.fix) {
            console.log("\n🔓 Opening System Settings → Privacy & Security → Screen Recording...");
            spawn("open", [
              "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            ], { detached: true, stdio: "ignore" }).unref();
            if (missingInput) {
              spawn("open", [
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
              ], { detached: true, stdio: "ignore" }).unref();
            }
          } else {
            console.log("\nRun `knowhow computer doctor --fix` to open System Settings automatically.");
          }
        } else {
          console.log("\n✅ All permissions OK.");
        }
      } catch (e: any) {
        console.error(`No usable driver: ${e?.message || e}`);
        process.exitCode = 1;
      }

      // ── host (resident process: kill switch, global hotkeys, workers) ──
      console.log("\nComputer host:");
      const bin = hostBinaryPath();
      console.log(`  binary:  ${bin ?? "NOT FOUND (cargo build --release in packages/knowhow-computer-host, or set KNOWHOW_HOST_BIN)"}`);
      const st = await probeHost();
      if (!st) {
        console.log("  running: no (started automatically by `computer run-automation`, or `computer host start`)");
      } else {
        console.log(`  running: yes (pid ${st.pid}, v${st.version}, ${st.platform})`);
        console.log(`  kill switch: ${st.killSwitch}`);
        console.log(`  armed:   ${st.killSwitchArmed ? "yes" : "NO"}`);
        if (st.hookError) console.log(`  hookError: ${st.hookError}`);
      }
    });

  cmd
    .command("displays")
    .description("List displays.")
    .action(async () => {
      const svc = buildService();
      console.log(JSON.stringify(await svc.getDisplays(), null, 2));
    });

  cmd
    .command("size")
    .description("Print screen size.")
    .action(async () => {
      const svc = buildService();
      console.log(JSON.stringify(await svc.screenSize()));
    });

  cmd
    .command("windows")
    .aliases(["list-windows"])
    .description("List open windows.")
    .option("--json", "Print full window objects (title/app/bounds) as JSON")
    .action(async (opts) => {
      const svc = buildService();
      const windows = await svc.listWindows();
      if (opts.json) {
        console.log(JSON.stringify(windows, null, 2));
        return;
      }
      for (const w of windows) {
        console.log(`${w.app ? `[${w.app}] ` : ""}${w.title}`);
      }
    });

  cmd
    .command("move <x> <y>")
    .description("Move the mouse to (x, y).")
    .action(async (x, y) => {
      const svc = buildService();
      await svc.moveMouse({ x: Number(x), y: Number(y) });
      console.log(`Moved to (${x}, ${y})`);
    });

  cmd
    .command("click")
    .description("Click the mouse.")
    .option("--button <button>", "left|right|middle", "left")
    .option("--double", "Double click")
    .action(async (opts) => {
      const svc = buildService();
      await svc.click(opts.button, { double: !!opts.double });
      console.log(`Clicked ${opts.button}`);
    });

  cmd
    .command("type <text>")
    .description("Type text.")
    .action(async (text) => {
      const svc = buildService();
      await svc.typeText(text);
      console.log(`Typed ${text.length} chars`);
    });

  cmd
    .command("hotkey <keys...>")
    .description("Press a key chord, e.g. hotkey control c")
    .action(async (keys) => {
      const svc = buildService();
      await svc.hotkey(...keys);
      console.log(`Hotkey ${keys.join("+")}`);
    });

  cmd
    .command("scroll <dx> <dy>")
    .description(
      "Scroll by (dx, dy) line deltas. Use --repeat/--interval-ms for smooth stepped scrolling."
    )
    .option("--repeat <n>", "Repeat the scroll N times", "1")
    .option("--interval-ms <ms>", "Delay between repeats (ms)", "0")
    .action(async (dx, dy, opts) => {
      const svc = buildService();
      await svc.scrollBy(Number(dx), Number(dy), {
        repeat: Number(opts.repeat),
        intervalMs: Number(opts.intervalMs),
      });
      console.log(
        `Scrolled (${dx}, ${dy}) x${opts.repeat}${
          Number(opts.intervalMs) ? ` @${opts.intervalMs}ms` : ""
        }`
      );
    });

  cmd
    .command("screenshot")
    .description("Capture a screenshot.")
    .option("--out <file>", "Output file (png/jpeg)")
    .option("--display <id>", "Display id")
    .option("--region <x,y,w,h>", "Crop region as x,y,width,height")
    .option("--scale <factor>", "Downscale factor (e.g. 0.5)")
    .option("--grid", "Overlay a labeled coordinate grid")
    .option("--crosshair <x,y>", "Draw a crosshair marker at x,y")
    .action(async (opts) => {
      const svc = buildService();
      const shot: any = {};
      if (opts.display !== undefined) shot.displayId = Number(opts.display);
      if (opts.region) {
        const [x, y, w, h] = String(opts.region).split(",").map(Number);
        shot.region = { x, y, width: w, height: h };
      }
      if (opts.scale) shot.scale = Number(opts.scale);
      let buf: Buffer;
      if (opts.grid || opts.crosshair) {
        if (opts.grid) shot.grid = true;
        if (opts.crosshair) {
          const [cx, cy] = String(opts.crosshair).split(",").map(Number);
          shot.crosshair = { x: cx, y: cy };
        }
        buf = await svc.screenshotAnnotated(shot);
      } else {
        buf = await svc.screenshot(
          Object.keys(shot).length ? shot : undefined
        );
      }
      if (opts.out) {
        fs.writeFileSync(opts.out, buf);
        console.log(`Wrote ${opts.out} (${buf.length} bytes)`);
      } else {
        console.log(buf.toString("base64"));
      }
    });

  // ── window control ─────────────────────────────────────────────────────
  cmd
    .command("active-window")
    .description("Print the currently focused/active window.")
    .action(async () => {
      const svc = buildService();
      const w = await svc.getActiveWindow();
      console.log(w ? JSON.stringify(w) : "No active window.");
    });

  cmd
    .command("read-text")
    .description("Read text from the screen (or a named region) using Vision OCR. macOS only.")
    .option("--region <name>", "Named region to restrict OCR to (e.g. profilePanel)")
    .option("--display-id <id>", "Restrict OCR to one display id (from `computer displays`)", parseInt)
    .option("--active-window", "Restrict OCR to the currently focused window")
    .option("--fast", "Use faster, less accurate Vision recognition")
    .option("--min-confidence <n>", "Minimum confidence threshold 0-1 (default 0.3)", parseFloat)
    .option("--json", "Output full JSON (text, confidence, bounds, center)")
    .action(async (opts) => {
      const svc = buildService();
      const results = await svc.readText({
        region: opts.region,
        displayId: opts.displayId,
        activeWindow: opts.activeWindow,
        minConfidence: opts.minConfidence ?? 0.3,
        recognitionLevel: opts.fast ? "fast" : "accurate",
      });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      if (!results.length) {
        console.log("(no text recognized)");
        return;
      }
      for (const r of results) {
        const { x, y } = r.center;
        console.log(
          `[${Math.round(r.confidence * 100)}%] ${r.text}  @(${Math.round(x)},${Math.round(y)})`
        );
      }
    });

  // ── region visualization ───────────────────────────────────────────────
  cmd
    .command("regions")
    .aliases(["list-regions"])
    .description("List named regions saved in .knowhow/automations/regions.json.")
    .option("--json", "Print the full region map as JSON")
    .action(async (opts) => {
      const all = listRegions();
      const names = Object.keys(all);
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      if (!names.length) return console.log("No regions defined.");
      for (const name of names) {
        const r = all[name];
        if (isWindowRelativeRegion(r)) {
          console.log(
            `- ${name} [window-normalized]: ${JSON.stringify(r.region)} anchor=${JSON.stringify(r.anchor.window)}`
          );
          continue;
        }
        const b = storedBounds(r);
        const kind = isRegionShape(r) ? ` [${r.type}]` : "";
        console.log(
          `- ${name}${kind}: x=${b.x} y=${b.y} ${b.width}x${b.height}`
        );
      }
    });

  cmd
    .command("render-regions [names...]")
    .description(
      "Screenshot the screen with saved regions drawn as translucent yellow rectangles. " +
        "Pass region name(s) to render only those; omit to render all. Writes a PNG (default regions.png)."
    )
    .option("--out <file>", "Output PNG file", "regions.png")
    .option("--display <id>", "Display id")
    .option("--scale <factor>", "Downscale factor (e.g. 0.5)")
    .option("--grid", "Also overlay a labeled coordinate grid")
    .option(
      "--auto",
      "Auto-detect UI boxes (findBoxes) and overlay them colored by nesting depth"
    )
    .option(
      "--auto-mode <mode>",
      "Auto-detect strategy: 'edges' (findBoxes, big panels) | 'segments' (per-color regions, finds buttons/cards & nests them) | 'panels' (background surfaces + grouped foreground content: score/toolbar/button clusters)",
      "segments"
    )
    .option(
      "--color-bits <n>",
      "Color granularity for segments/panels mode (1-8, higher = finer)",
      "3"
    )
    .option(
      "--cluster-gap <n>",
      "panels mode: px to merge nearby foreground content into one group (default 10)",
    )
    .option(
      "--bg-area-frac <n>",
      "panels mode: min fraction of frame a same-color area must cover to be a background surface (default 0.004)",
    )
    .option("--min-size <n>", "Min box size for --auto (px)", "24")
    .option("--max-depth <n>", "Only draw --auto boxes up to this nesting depth")
    .option("--edge-threshold <n>", "Edge gradient threshold for --auto")
    .option(
      "--min-edge-score <n>",
      "Fraction of each border that must be edge pixels for --auto (0..1)"
    )
    .action(async (names: string[], opts) => {
      const svc = buildService();
      const all = listRegions();
      const selectedNames =
        names && names.length ? names : Object.keys(all);
      if (!selectedNames.length && !opts.auto) {
        console.log(
          "No regions defined. Define one first (e.g. from an automation via sdk.defineRegion)."
        );
        return;
      }
      const regions: Array<{ name: string; region: any }> = [];
      const shapes: Array<{ name: string; shape: any }> = [];
      for (const name of selectedNames) {
        const stored = getStoredRegion(name);
        if (!stored) {
          console.error(`⚠️  Unknown region: "${name}" (skipping)`);
          continue;
        }
        if (isRegionShape(stored)) {
          // Non-rect (circle/polygon/svgpath/union/subtract): draw as a shape
          // so holes/curves render accurately, not just the bounding box.
          shapes.push({ name, shape: stored });
        } else {
          regions.push({ name, region: stored });
        }
      }
      if (!regions.length && !shapes.length && !opts.auto) {
        console.error("None of the requested regions could be resolved.");
        process.exitCode = 1;
        return;
      }
      const shot: any = { regions, shapes };
      if (opts.display !== undefined) shot.displayId = Number(opts.display);
      if (opts.scale) shot.scale = Number(opts.scale);
      if (opts.grid) shot.grid = true;
      if (opts.auto) {
        // Detect UI boxes and flatten the nested tree so every box (at every
        // depth) is drawn. This is the "show me all the bounding boxes you see"
        // view of the auto-detection.
        const findOpts: any = {};
        if (opts.display !== undefined) findOpts.displayId = Number(opts.display);
        if (opts.scale) findOpts.scale = Number(opts.scale);
        if (opts.minSize) findOpts.minSize = Number(opts.minSize);
        if (opts.edgeThreshold)
          findOpts.edgeThreshold = Number(opts.edgeThreshold);
        if (opts.minEdgeScore)
          findOpts.minEdgeScore = Number(opts.minEdgeScore);
        const maxDepth =
          opts.maxDepth !== undefined ? Number(opts.maxDepth) : Infinity;
        const mode =
          opts.autoMode === "edges"
            ? "edges"
            : opts.autoMode === "panels"
            ? "panels"
            : "segments";
        let tree;
        if (mode === "segments") {
          // Color-segmentation: finds buttons/cards/text and nests same-color
          // areas by containment (catches the "Start Game" button & the "API
          // Endpoints" card that whole-frame edge detection misses).
          findOpts.mode = "colors";
          findOpts.colorBits = Number(opts.colorBits || 3);
          tree = await svc.findRegions(findOpts);
        } else if (mode === "panels") {
          // Background surfaces + grouped foreground content: models the UI the
          // way a person eyes it, so the score/rounds/hits readout, a toolbar,
          // or a row of buttons are captured as grouped boxes over a shared bg.
          findOpts.mode = "panels";
          findOpts.colorBits = Number(opts.colorBits || 3);
          if (opts.clusterGap !== undefined)
            findOpts.clusterGap = Number(opts.clusterGap);
          if (opts.bgAreaFrac !== undefined)
            findOpts.bgAreaFrac = Number(opts.bgAreaFrac);
          tree = await svc.findRegions(findOpts);
        } else {
          tree = await svc.findBoxes(findOpts);
        }
        const flat: Array<{ bounds: any; depth: number }> = [];
        const walk = (nodes: any[]) => {
          for (const n of nodes) {
            if (n.depth <= maxDepth) flat.push({ bounds: n.bounds, depth: n.depth });
            if (n.children?.length) walk(n.children);
          }
        };
        walk(tree);
        shot.boxes = flat;
        console.log(`Auto-detected ${flat.length} box(es) [mode=${mode}].`);
      }
      const buf = await svc.screenshotAnnotated(shot);
      fs.writeFileSync(opts.out, buf);
      console.log(
        `Rendered ${regions.length} rect region(s) + ${shapes.length} shape region(s)${
          opts.auto ? ` + ${shot.boxes?.length ?? 0} auto-box(es)` : ""
        } [${[...regions, ...shapes]
          .map((r) => r.name)
          .join(", ")}] -> ${opts.out} (${buf.length} bytes)`
      );
    });

  cmd
    .command("focus <match>")
    .description("Focus/activate a window or app by name (e.g. 'Google Chrome').")
    .action(async (match) => {
      const svc = buildService();
      const ok = await svc.focusWindow(match);
      console.log(ok ? `Focused: ${match}` : `Could not focus: ${match}`);
      if (!ok) process.exitCode = 1;
    });

  // ── extra mouse/keyboard verbs ─────────────────────────────────────────
  cmd
    .command("click-at <x> <y>")
    .description("Move to (x, y) then click in one step.")
    .option("--button <button>", "left|right|middle", "left")
    .option("--double", "Double click")
    .action(async (x, y, opts) => {
      const svc = buildService();
      await svc.moveMouse({ x: Number(x), y: Number(y) });
      await svc.click(opts.button, { double: !!opts.double });
      console.log(`Clicked ${opts.button} at (${x}, ${y})`);
    });

  cmd
    .command("drag <fromX> <fromY> <toX> <toY>")
    .description("Press at (fromX,fromY), move to (toX,toY), release.")
    .option("--button <button>", "left|right|middle", "left")
    .action(async (fx, fy, tx, ty, opts) => {
      const svc = buildService();
      await svc.drag(
        { x: Number(fx), y: Number(fy) },
        { x: Number(tx), y: Number(ty) },
        { button: opts.button }
      );
      console.log(`Dragged (${fx},${fy}) -> (${tx},${ty})`);
    });

  cmd
    .command("press <key>")
    .description("Press a single named key, e.g. Enter, Escape, ArrowDown.")
    .action(async (key) => {
      const svc = buildService();
      await svc.pressKey(key);
      console.log(`Pressed ${key}`);
    });

  cmd
    .command("pixel <x> <y>")
    .description("Print the #RRGGBB color at (x, y).")
    .action(async (x, y) => {
      const svc = buildService();
      console.log(await svc.pixelColor({ x: Number(x), y: Number(y) }));
    });

  cmd
    .command("mouse")
    .description("Print the current mouse position.")
    .action(async () => {
      const svc = buildService();
      console.log(JSON.stringify(await svc.mousePosition()));
    });

  cmd
    .command("find-colors <colors...>")
    .description("Find solid-color regions and print their click-ready desktop coordinates.")
    .option("--tolerance <n>", "Per-channel tolerance", "12")
    .option("--min-pixels <n>", "Minimum sampled matching pixels", "20")
    .option("--min-size <n>", "Minimum region size", "1")
    .option("--max-size <n>", "Maximum region size", "10000")
    .action(async (colors, opts) => {
      const svc = buildService();
      const regions = await svc.findColorRegions({
        colors,
        tolerance: Number(opts.tolerance),
        minPixels: Number(opts.minPixels),
        minSize: Number(opts.minSize),
        maxSize: Number(opts.maxSize),
      });
      console.log(JSON.stringify(regions, null, 2));
    });

  cmd
    .command("click-colors <colors...>")
    .description("Detect and click changing solid-color targets in one low-latency loop.")
    .option("--max-clicks <n>", "Number of targets to click", "20")
    .option("--timeout-ms <n>", "Overall timeout", "30000")
    .option("--tolerance <n>", "Per-channel tolerance", "12")
    .option("--min-pixels <n>", "Minimum sampled matching pixels", "20")
    .option("--min-size <n>", "Minimum target size", "5")
    .option("--max-size <n>", "Maximum target size", "200")
    .option("--poll-ms <n>", "Delay while waiting for target change", "10")
    .action(async (colors, opts) => {
      const svc = buildService();
      const result = await svc.clickColorSequence({
        colors,
        maxClicks: Number(opts.maxClicks),
        timeoutMs: Number(opts.timeoutMs),
        tolerance: Number(opts.tolerance),
        minPixels: Number(opts.minPixels),
        minSize: Number(opts.minSize),
        maxSize: Number(opts.maxSize),
        pollIntervalMs: Number(opts.pollMs),
      });
      console.log(JSON.stringify(result, null, 2));
    });

  // ── macro / batch runner ───────────────────────────────────────────────
  cmd
    .command("run <file>")
    .description(
      "Run a macro file (JSON/YAML list of steps) in ONE process — the smooth batch runner."
    )
    .option("--continue-on-error", "Keep going past failed steps")
    .option("--delay-ms <ms>", "Default delay between steps (ms)", "0")
    .action(async (file, opts) => {
      const svc = buildService();
      const steps = parseMacroFile(file);
      const results = await runMacro(svc, steps, {
        continueOnError: !!opts.continueOnError,
        defaultStepDelayMs: Number(opts.delayMs),
        onStep: (r) =>
          console.log(
            `${r.ok ? "✓" : "✗"} [${r.step}] ${r.action}${
              r.detail ? ` — ${r.detail}` : ""
            }`
          ),
      });
      const failed = results.filter((r) => !r.ok).length;
      console.log(
        `Ran ${results.length} step(s), ${failed} failed.`
      );
      if (failed && !opts.continueOnError) process.exitCode = 1;
    });

  // ── automations ────────────────────────────────────────────────────────────
  // A CLI harness for authoring/testing automations against the FRESHLY COMPILED
  // module. Because these commands `require` the compiled ComputerService + SDK
  // each run, recompiling (`npm run compile`) hot-reloads the logic — so tool/SDK
  // changes can be iterated here WITHOUT a long-lived agent session (which caches
  // the module and has no reload-tools mechanism).
  cmd
    .command("automations")
    .description("List saved automations (from .knowhow/automations/*.ts).")
    .action(async () => {
      const specs = listAutomations();
      if (!specs.length) return console.log("No automations defined.");
      for (const s of specs) {
        console.log(`- ${s.name}.ts  (${s.script.length} chars)`);
      }
    });

  cmd
    .command("write-automation <name> <scriptFile>")
    .description(
      "Save an automation as <name>.ts (async body using only `sdk`). Configuration belongs in the script."
    )
    .action(async (name, scriptFile) => {
      const script = fs.readFileSync(scriptFile, "utf8");
      validateScript(script);
      const spec: AutomationSpec = { name, script };
      const saved = saveAutomation(spec);
      console.log(`Saved automation "${name}" (${saved.script.length} chars).`);
    });

  const runAutomationCli = async (
    name: string,
    opts: { maxMs?: string; dryRun?: boolean; driver?: string; paramsJson?: string }
  ) => {
    const svc = buildService(opts.driver);
    const spec = loadAutomation(name);
    let params: Record<string, unknown> | undefined;
    if (opts.paramsJson) {
      const parsed = JSON.parse(opts.paramsJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--params-json must be a JSON object.");
      }
      params = parsed;
    }
    // Gracefully try to pick up the ExtensionsService from the global
    // singletons (populated when the full services graph is running). The
    // standalone CLI phase won't have it, which is fine — extensions just
    // won't be available in that case.
    let cliExtensions: ExtensionsService | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { services } = require("@tyvm/knowhow/ts_build/src/services/index") as { services(): any };
      const singletons = services();
      if (singletons?.Extensions instanceof ExtensionsService) {
        cliExtensions = singletons.Extensions;
      }
    } catch { /* standalone CLI — ExtensionsService not available */ }
    // Lightweight module load: register voice/gaze extensions from modules config
    // without the heavy setupServices() path (no MCP, no AI clients, no agents).
    // This ensures sdk.ext.gaze and sdk.ext.voice are available in automations
    // that import the voice-control module's extensions (e.g. fruitNinjaGazeSlice).
    if (cliExtensions) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ModulesService } = require("@tyvm/knowhow/ts_build/src/services/modules/index") as { ModulesService: any };
        const ms = new ModulesService();
        // Pass only Extensions + Program so module register() runs and extensions
        // get registered. Other context keys (Agents, Clients, etc.) are left
        // undefined — module init() calls that need them will skip gracefully.
        await ms.loadModulesFromConfig({ Extensions: cliExtensions });
      } catch (modErr: any) {
        // Non-fatal: if module loading fails (e.g. a module needs full context),
        // the automation still runs — extensions just won't be available.
        console.warn(`[computer] Extension load warning: ${modErr?.message ?? modErr}`);
      }
    }
    const runner = new AutomationRunner(spec, svc, {
      maxDurationMs: opts.maxMs ? Number(opts.maxMs) : undefined,
      params,
      dryRun: !!opts.dryRun,
      onLog: (e) => console.log(`t+${e.t}ms ${JSON.stringify(e.data)}`),
      extensions: cliExtensions,
    });
    console.log(
      `${opts.dryRun ? "DRY-RUN" : "RUN"} automation "${name}"${
        opts.dryRun ? " (no real mouse/keyboard)" : ""
      }...`
    );
    // Ctrl-C cooperatively stops the automation. runEvery now yields to the
    // macrotask queue every iteration, so this handler is actually delivered
    // even when the per-frame callback overruns its interval budget. A second
    // Ctrl-C hard-exits in case a driver call is genuinely wedged.
    let interrupts = 0;
    const onSigint = () => {
      interrupts++;
      if (interrupts >= 2) {
        console.log("\nForce exiting.");
        process.exit(130);
      }
      console.log("\nStopping automation (Ctrl-C again to force quit)...");
      runner.ctl.stop();
    };
    process.on("SIGINT", onSigint);
    try {
    const result = await runner.run();
    process.off("SIGINT", onSigint);
    console.log("\n=== summary ===");
    console.log(
      JSON.stringify(
        {
          stopped: result.stopped,
          error: result.error,
          elapsedMs: result.elapsedMs,
          pausedMs: result.pausedMs,
          actionCount: result.actionCount,
          dryRun: result.dryRun,
        },
        null,
        2
      )
    );
    } finally {
      process.off("SIGINT", onSigint);
    }
  };

  // Tail a worker log until the worker exits; Ctrl+C asks the host to stop it.
  const attachToWorker = async (workerId: string, logPath: string) => {
    let offset = 0;
    let stopping = false;
    const pump = () => {
      try {
        const st = fs.statSync(logPath);
        if (st.size > offset) {
          const fd = fs.openSync(logPath, "r");
          const buf = Buffer.alloc(st.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = st.size;
          process.stdout.write(buf.toString("utf8"));
        }
      } catch {
        /* log not created yet */
      }
    };
    const onSigint = () => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log("\nStopping automation via host...");
      hostOps.stopAutomations({ id: workerId }).catch(() => {});
    };
    process.on("SIGINT", onSigint);
    try {
      for (;;) {
        pump();
        const w = (await hostOps.listWorkers()).find((x) => x.id === workerId);
        if (!w || w.status === "exited") {
          pump();
          if (w && w.exitCode) process.exitCode = w.exitCode;
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      process.off("SIGINT", onSigint);
    }
  };

  cmd
    .command("run-automation <nameOrPath>")
    .description(
      "Run an automation LIVE (real mouse/keyboard). <nameOrPath> is a saved name (.knowhow/automations, ./automations, automationPaths) or a script path (./automations/foo.ts, absolute, Windows paths OK); relative imports resolve next to the script."
    )
    .option("--driver <name>", "Pin a driver by name")
    .option("--params-json <json>", "JSON object exposed read-only as sdk.params")
    .option(
      "--max-ms <ms>",
      "Max run duration in ms (default 30000, HARD-CAPPED at 300000 until the global kill switch is armed, so a human can always reclaim the mouse)"
    )
    .option("--host", "Run under the knowhow computer host (default when a host binary is found)")
    .option("--no-host", "Run in-process, without the host (no global hotkeys / kill switch)")
    .option("--attach", "Tail the worker log until it exits (default when stdout is a TTY)")
    .option("--no-attach", "Return as soon as the host has started the worker")
    .action(async (name, opts) => {
      const useHost =
        opts.host === true ||
        (opts.host !== false && (!!hostBinaryPath() || !!(await probeHost())));
      if (!useHost) return runAutomationCli(name, opts);
      const res = await hostOps.startAutomation(name, {
        params: opts.paramsJson,
        maxMs: opts.maxMs,
      });
      if (!res.started) {
        console.log(`"${name}" is already running (worker ${res.worker.id}); singleInstance: ignore.`);
        return;
      }
      console.log(`Started "${name}" under host (worker ${res.worker.id}, pid ${res.worker.pid}).`);
      console.log(`Log: ${res.worker.logPath}`);
      const attach = opts.attach ?? !!process.stdout.isTTY;
      if (attach) await attachToWorker(res.worker.id, res.worker.logPath);
    });

  cmd
    .command("test-automation <name>")
    .description(
      "DRY-RUN a saved automation against LIVE perception without moving the mouse — prints what it WOULD click."
    )
    .option("--driver <name>", "Pin a driver by name")
    .option("--params-json <json>", "JSON object exposed read-only as sdk.params")
    .option("--max-ms <ms>", "How long to observe in ms (default 8000)")
    .action((name, opts) =>
      runAutomationCli(name, {
        ...opts,
        maxMs: opts.maxMs ?? "8000",
        dryRun: true,
      })
    );

  // ── host-managed automation control ──────────────────────────────────────
  const fmtAge = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
  };
  const guard = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => {
    try {
      await fn(...a);
    } catch (e: any) {
      console.error(e?.message ?? String(e));
      process.exitCode = 1;
    }
  };
  const report = (verb: string, r: { workers?: string[]; stopped?: string[]; errors?: string[] }) => {
    const ids = r.workers ?? r.stopped ?? [];
    console.log(`${verb} ${ids.length} worker(s)${ids.length ? `: ${ids.join(", ")}` : ""}`);
    for (const e of r.errors ?? []) console.error(`  ! ${e}`);
  };

  cmd
    .command("ps")
    .description("List host-managed running automations.")
    .action(guard(async () => {
      const ws = await hostOps.listWorkers();
      if (!ws.length) return console.log("No host-managed automations running.");
      for (const w of ws) {
        console.log(
          `${w.id}  ${w.name.padEnd(20)} ${w.status.padEnd(8)} pid=${w.pid} up=${fmtAge(w.startedAt)} hotkeys=${w.hotkeyCount}${w.hotkeysSuspended ? "(suspended)" : ""}${w.trayStatus ? ` [${w.trayStatus}]` : ""}`
        );
      }
    }));

  cmd
    .command("stop [name]")
    .description("Stop a host-managed automation by name (or --all).")
    .option("--all", "Stop every running automation")
    .action(guard(async (name, opts) => {
      if (!name && !opts.all) throw new Error("Specify <name> or --all.");
      report("Stopped", await hostOps.stopAutomations(opts.all ? { all: true } : { name }));
    }));

  cmd
    .command("pause <name>")
    .description("Pause a host-managed automation (also suspends its hotkeys).")
    .action(guard(async (name) => report("Paused", await hostOps.pauseAutomations({ name }))));

  cmd
    .command("resume <name>")
    .description("Resume a paused host-managed automation.")
    .action(guard(async (name) => report("Resumed", await hostOps.resumeAutomations({ name }))));

  cmd
    .command("restart <name>")
    .description("Restart a host-managed automation with its original arguments.")
    .action(guard(async (name) => {
      const r = await hostOps.restartAutomation(name);
      console.log(`Restarted "${name}" (worker ${r.worker.id}, pid ${r.worker.pid}).`);
    }));

  cmd
    .command("make-launcher <script>")
    .description(
      "Write a double-click launcher next to <script> (Windows .cmd [+ .vbs], macOS .command, Linux .sh). Committable: no absolute paths."
    )
    .option("--out <file>", "Output file (single platform only)")
    .option("--platform <list>", "win32,darwin,linux or all (comma separated; default: this OS)")
    .option("--cwd <dir>", "Working dir for the automation, relative to the script's dir (default '.')")
    .option("--vbs", "Windows: also write <name>.vbs which launches with no console window")
    .action(guard(async (script, opts) => {
      const written = writeLaunchers({
        script,
        out: opts.out,
        cwd: opts.cwd,
        vbs: !!opts.vbs,
        platforms: parsePlatforms(opts.platform),
      });
      for (const w of written) console.log(`Wrote ${w.file} (${w.platform})`);
    }));

  cmd
    .command("register-filetype")
    .description(
      "Windows: associate an extension (default .khs) with `knowhow computer run-automation` for double-click (HKCU only, no admin)."
    )
    .option("--ext <ext>", "Extension to register (default .khs)")
    .option("--unregister", "Remove the association")
    .option("--dry-run", "Print the reg.exe commands without running them")
    .action(guard(async (opts) => {
      const lines = registerFiletype(opts.ext, { unregister: !!opts.unregister, dryRun: !!opts.dryRun });
      for (const l of lines) console.log(opts.dryRun ? l : `ran: ${l}`);
    }));

  const hostCmd = cmd.command("host").description("Manage the resident computer host process.");
  hostCmd
    .command("start")
    .option("--no-tray", "Run without the tray icon")
    .description("Start the host (detached) if it is not already running.")
    .action(guard(async (opts) => {
      const st = await ensureHost({ args: opts.tray === false ? ["--no-tray"] : [] });
      console.log(`Host running (pid ${st.pid}); kill switch ${st.killSwitch}, armed=${st.killSwitchArmed}`);
      if (st.hookError) console.log(`hookError: ${st.hookError}`);
    }));
  hostCmd
    .command("stop")
    .description("Stop all automations and shut the host down.")
    .action(guard(async () => {
      if (!(await probeHost())) return console.log("Host is not running.");
      await hostOps.hostRequest({ type: "shutdown" });
      console.log("Host shutting down.");
    }));
  hostCmd
    .command("status")
    .description("Show host status.")
    .action(guard(async () => {
      const st = await probeHost();
      if (!st) return console.log("Host is not running.");
      console.log(JSON.stringify(st, null, 2));
    }));

  cmd
    .command("keys")
    .description("Print key names as pressed (to author hotkey specs).")
    .option("--listen", "Start listening (Ctrl+C to quit)")
    .action(guard(async (opts) => {
      const bin = hostBinaryPath();
      if (!bin) throw new Error("knowhow-computer-host binary not found.");
      if (!opts.listen) return console.log("Use `computer keys --listen`.");
      await new Promise<void>((resolve) => {
        const child = spawn(bin, ["--print-keys"], { stdio: "inherit" });
        child.on("exit", () => resolve());
        child.on("error", (e) => {
          console.error(e.message);
          resolve();
        });
      });
    }));

  // ── computer-use agent ─────────────────────────────────────────────────
  // Spawns a knowhow agent primed for computer use, with models pre-selected
  // for their performance driving a GUI. It shells out to `knowhow agent` so
  // it reuses the full agent lifecycle (cost tracking, sync, rendering) rather
  // than re-implementing it here.
  cmd
    .command("agent")
    .description(
      "Spin up an agent that can see and control the computer to do a task."
    )
    .option("--input <text>", "The task, e.g. 'open X and scroll the timeline'")
    .option("--provider <provider>", "Override the AI provider")
    .option("--model <model>", "Override the model")
    .option(
      "--reasoning-effort <effort>",
      "Reasoning effort: none, low, medium, high. Use 'none'/'low' for faster computer-use on models that support it."
    )
    // Forgiving alias: users frequently type the underscore form. Without this,
    // allowUnknownOption(true) would silently swallow `--reasoning_effort low`.
    .option(
      "--reasoning_effort <effort>",
      "Alias for --reasoning-effort."
    )
    .option("--agent-name <name>", "Base agent to use", cliOpts.agentName || "Patcher")
    .option("--max-time-limit <minutes>", "Time limit (minutes)", "30")
    .option("--max-spend-limit <dollars>", "Cost limit (dollars)", "10")
    .allowUnknownOption(true)
    .action(async (opts) => {
      const input = opts.input;
      if (!input) {
        console.error(
          "Provide a task with --input, e.g. knowhow computer agent --input \"open X and scroll\""
        );
        process.exitCode = 1;
        return;
      }
      // Write the primed prompt to a temp prompt-file ({text} -> user input).
      const promptPath = path.join(
        os.tmpdir(),
        `knowhow-computer-agent-${Date.now()}.txt`
      );
      fs.writeFileSync(promptPath, COMPUTER_USE_PROMPT);

      // Model selection precedence: CLI flag > config preset > sensible default.
      // Default model is chosen for strong computer-use / GUI-grounding perf.
      const DEFAULT_CU_MODEL = "gpt-5.6-luna";
      const provider = opts.provider || cliOpts.agentProvider;
      const model = opts.model || cliOpts.agentModel || DEFAULT_CU_MODEL;

      const args = [
        "agent",
        "--agent-name",
        opts.agentName,
        "--prompt-file",
        promptPath,
        "--input",
        input,
        "--max-time-limit",
        String(opts.maxTimeLimit),
        "--max-spend-limit",
        String(opts.maxSpendLimit),
      ];
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
      const reasoningEffort =
        opts.reasoningEffort || opts.reasoning_effort;
      if (reasoningEffort)
        args.push("--reasoning-effort", String(reasoningEffort));

      console.log(
        `🤖 Launching computer-use agent (${provider || "default"}/${
          model || "default"
        })...`
      );
      const child = spawn("knowhow", args, { stdio: "inherit" });
      await new Promise<void>((resolve) => {
        child.on("exit", (code) => {
          try {
            fs.unlinkSync(promptPath);
          } catch {
            // ignore
          }
          process.exitCode = code ?? 0;
          resolve();
        });
        child.on("error", (err) => {
          console.error(`Failed to launch knowhow agent: ${err.message}`);
          process.exitCode = 1;
          resolve();
        });
      });
    });
}
