import * as fs from "fs";
import type { Command } from "commander";
import { ComputerService } from "./ComputerService";
import { RustCoreDriver } from "./drivers/RustCoreDriver";
import { parseMacroFile, runMacro } from "./macro";
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import { COMPUTER_USE_PROMPT } from "./prompt";

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
    .description("List open windows.")
    .action(async () => {
      const svc = buildService();
      const windows = await svc.listWindows();
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
