import { ComputerUseService } from "@tyvm/knowhow";
import {
  ClickColorSequenceOptions,
  ComputerService,
} from "../ComputerService";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import * as fs from "fs";
import { runMacro, MacroStep, parseMacroFile } from "../macro";

/**
 * Resolve the ComputerUse service from the bound ToolsService context.
 *
 * Tool functions are bound to the ToolsService that registered them, so `this`
 * is the ToolsService and `this.getContext().ComputerUse` is the service that
 * the module injected during its `register()` phase. (Falls back gracefully if
 * a caller invokes the function unbound.)
 */
function getService(self: unknown): ComputerUseService {
  const toolService = self as ToolsService | undefined;
  const svc =
    toolService && typeof toolService.getContext === "function"
      ? (toolService.getContext().ComputerUse as ComputerUseService | undefined)
      : undefined;
  if (!svc) {
    throw new Error(
      "ComputerUse service not available. Is @tyvm/knowhow-module-computer-use enabled in knowhow.json modules?"
    );
  }
  return svc;
}

// ── screen / capture ───────────────────────────────────────────────────────

export async function getScreenSize(this: ToolsService): Promise<string> {
  const size = await getService(this).screenSize();
  return JSON.stringify(size);
}

export async function getDisplays(this: ToolsService): Promise<string> {
  const displays = await getService(this).getDisplays();
  return JSON.stringify(displays, null, 2);
}

export async function screenshot(
  this: ToolsService,
  displayId?: number,
  region?: { x: number; y: number; width: number; height: number },
  scale?: number,
  grid?: boolean,
  crosshair?: { x: number; y: number },
  out?: string
): Promise<{ type: string; image_url: { url: string } }[] | string> {
  const svc = getService(this) as any;
  const opts: any = {};
  if (displayId !== undefined) opts.displayId = displayId;
  if (region) opts.region = region;
  if (scale !== undefined) opts.scale = scale;

  let buf: Buffer;
  if ((grid || crosshair) && typeof svc.screenshotAnnotated === "function") {
    if (grid) opts.grid = true;
    if (crosshair) opts.crosshair = crosshair;
    buf = await svc.screenshotAnnotated(opts);
  } else {
    buf = await svc.screenshot(Object.keys(opts).length ? opts : undefined);
  }

  // Optionally persist to disk (mirrors the CLI --out flag).
  if (out) {
    fs.writeFileSync(out, buf);
    return `Wrote screenshot to ${out} (${buf.length} bytes)`;
  }

  const b64 = buf.toString("base64");
  // Return a multimodal image part so it flows into a vision message, mirroring
  // loadWebpage(mode:"screenshot").
  return [
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    },
  ];
}

export async function screenshotRegion(
  this: ToolsService,
  x: number,
  y: number,
  width: number,
  height: number,
  displayId?: number,
  grid?: boolean
): Promise<{ type: string; image_url: { url: string } }[]> {
  const svc = getService(this) as any;
  const opts: any = { region: { x, y, width, height } };
  if (displayId !== undefined) opts.displayId = displayId;
  let buf: Buffer;
  if (grid && typeof svc.screenshotAnnotated === "function") {
    buf = await svc.screenshotAnnotated({ ...opts, grid: true });
  } else {
    buf = await svc.screenshot(opts);
  }
  const b64 = buf.toString("base64");
  return [
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    },
  ];
}

export async function getPixelColor(
  this: ToolsService,
  x: number,
  y: number
): Promise<string> {
  return getService(this).pixelColor({ x, y });
}

export async function findColorRegions(
  this: ToolsService,
  colors: string[],
  tolerance?: number,
  minPixels?: number,
  minSize?: number,
  maxSize?: number,
  displayId?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const regions = await svc.findColorRegions({
    colors, tolerance, minPixels, minSize, maxSize, displayId,
  });
  return JSON.stringify(regions, null, 2);
}

export async function clickColorSequence(
  this: ToolsService,
  colors: string[],
  maxClicks?: number,
  timeoutMs?: number,
  tolerance?: number,
  minPixels?: number,
  minSize?: number,
  maxSize?: number,
  pollIntervalMs?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const opts: ClickColorSequenceOptions = {
    colors, maxClicks, timeoutMs, tolerance, minPixels, minSize, maxSize, pollIntervalMs,
  };
  return JSON.stringify(await svc.clickColorSequence(opts), null, 2);
}

export async function getMousePosition(this: ToolsService): Promise<string> {
  return JSON.stringify(await getService(this).mousePosition());
}

// ── windows ────────────────────────────────────────────────────────────────

export async function listWindows(this: ToolsService): Promise<string> {
  const windows = await getService(this).listWindows();
  if (!windows.length)
    return "No windows found (or window listing unsupported on this platform/session).";
  return windows
    .map((w) => `- ${w.app ? `[${w.app}] ` : ""}${w.title}`)
    .join("\n");
}

export async function getActiveWindow(this: ToolsService): Promise<string> {
  const w = await getService(this).getActiveWindow();
  return w ? JSON.stringify(w) : "No active window.";
}

export async function focusWindow(
  this: ToolsService,
  match: string
): Promise<string> {
  const ok = await getService(this).focusWindow(match);
  return ok ? `Focused/activated: ${match}` : `Could not focus: ${match}`;
}

// ── mouse ──────────────────────────────────────────────────────────────────

export async function moveMouse(
  this: ToolsService,
  x: number,
  y: number
): Promise<string> {
  await getService(this).moveMouse({ x, y });
  return `Moved mouse to (${x}, ${y})`;
}

export async function click(
  this: ToolsService,
  button?: "left" | "right" | "middle"
): Promise<string> {
  await getService(this).click(button ?? "left");
  return `Clicked ${button ?? "left"}`;
}

export async function doubleClick(
  this: ToolsService,
  button?: "left" | "right" | "middle"
): Promise<string> {
  await getService(this).click(button ?? "left", { double: true });
  return `Double-clicked ${button ?? "left"}`;
}

export async function clickAt(
  this: ToolsService,
  x: number,
  y: number,
  button?: "left" | "right" | "middle"
): Promise<string> {
  const svc = getService(this);
  await svc.moveMouse({ x, y });
  await svc.click(button ?? "left");
  return `Clicked ${button ?? "left"} at (${x}, ${y})`;
}

export async function dragMouse(
  this: ToolsService,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<string> {
  await getService(this).drag({ x: fromX, y: fromY }, { x: toX, y: toY });
  return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
}

export async function scroll(
  this: ToolsService,
  dx: number,
  dy: number
): Promise<string> {
  await getService(this).scroll(dx, dy);
  return `Scrolled (dx=${dx}, dy=${dy})`;
}

export async function smoothScroll(
  this: ToolsService,
  dx: number,
  dy: number,
  repeat?: number,
  intervalMs?: number
): Promise<string> {
  const svc = getService(this) as any;
  if (typeof svc.scrollBy === "function") {
    await svc.scrollBy(dx, dy, { repeat, intervalMs });
  } else {
    const n = Math.max(1, Math.round(repeat ?? 1));
    for (let i = 0; i < n; i++) await svc.scroll(dx, dy);
  }
  return `Smooth-scrolled (dx=${dx}, dy=${dy}) x${repeat ?? 1}`;
}

// ── keyboard ───────────────────────────────────────────────────────────────

export async function typeText(
  this: ToolsService,
  text: string
): Promise<string> {
  await getService(this).typeText(text);
  return `Typed ${text.length} chars`;
}

export async function pressKey(
  this: ToolsService,
  key: string
): Promise<string> {
  await getService(this).pressKey(key);
  return `Pressed ${key}`;
}

export async function hotkey(
  this: ToolsService,
  keys: string[]
): Promise<string> {
  await getService(this).hotkey(...keys);
  return `Hotkey ${keys.join("+")}`;
}

// ── batch / macro ───────────────────────────────────────────────────────────

export async function runComputerMacro(
  this: ToolsService,
  steps: MacroStep[],
  continueOnError?: boolean
): Promise<string> {
  const svc = getService(this);
  const results = await runMacro(svc, steps, {
    continueOnError: !!continueOnError,
  });
  const failed = results.filter((r) => !r.ok);
  const lines = results.map(
    (r) =>
      `${r.ok ? "✓" : "✗"} [${r.step}] ${r.action}${
        r.detail ? ` — ${r.detail}` : ""
      }`
  );
  return (
    `Ran ${results.length} step(s), ${failed.length} failed.\n` +
    lines.join("\n")
  );
}

export async function runComputerMacroFile(
  this: ToolsService,
  file: string,
  continueOnError?: boolean
): Promise<string> {
  const svc = getService(this);
  const steps = parseMacroFile(file);
  const results = await runMacro(svc, steps, {
    continueOnError: !!continueOnError,
  });
  const failed = results.filter((r) => !r.ok);
  const lines = results.map(
    (r) =>
      `${r.ok ? "✓" : "✗"} [${r.step}] ${r.action}${
        r.detail ? ` — ${r.detail}` : ""
      }`
  );
  return (
    `Ran macro file ${file}: ${results.length} step(s), ${failed.length} failed.\n` +
    lines.join("\n")
  );
}
