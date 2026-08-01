import { ComputerUseService } from "@tyvm/knowhow";
import {
  ClickColorSequenceOptions,
  ComputerService,
} from "../ComputerService";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import { Region } from "@tyvm/knowhow/ts_build/src/services/modules/computerUse";
import * as fs from "fs";
import { runMacro, MacroStep, parseMacroFile } from "../macro";
import {
  defineRegion,
  listRegions,
  clearRegion,
  resolveRegion,
} from "../regions";
import {
  AutomationRunner,
  AutomationSpec,
  saveAutomation,
  loadAutomation,
  listAutomations,
  deleteAutomation,
  getRunning,
  listRunning,
  validateScript,
} from "../automation";

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

export async function computerUseGetScreenSize(this: ToolsService): Promise<string> {
  const size = await getService(this).screenSize();
  return JSON.stringify(size);
}

export async function computerUseGetDisplays(this: ToolsService): Promise<string> {
  const displays = await getService(this).getDisplays();
  return JSON.stringify(displays, null, 2);
}

export async function computerUseScreenshot(
  this: ToolsService,
  displayId?: number,
  region?: { x: number; y: number; width: number; height: number },
  scale?: number,
  grid?: boolean,
  crosshair?: { x: number; y: number },
  out?: string
): Promise<
  | (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    )[]
  | string
> {
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
  // Attach an explicit image->desktop coordinate mapping so the agent never has
  // to GUESS the downscale factor. The returned image may be smaller than the
  // captured desktop/region (the configured screenshotScale, e.g. 0.5 on 4K,
  // applies even when the caller passes no scale). Without this, an agent reads
  // a pixel off a 1920-wide image of a 3840-wide desktop and clicks at half the
  // real coordinate. When grid=true the labels already fold this in, but we emit
  // the mapping unconditionally so plain (grid-less) shots are unambiguous too.
  let mappingText: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    const meta = await sharp(buf).metadata();
    const outW = meta.width || 0;
    const outH = meta.height || 0;
    // The captured desktop-space size this image represents: the requested
    // region, or the full display/desktop when no region was given.
    let regionX = region?.x ?? 0;
    let regionY = region?.y ?? 0;
    let regionW = region?.width;
    let regionH = region?.height;
    if (regionW === undefined || regionH === undefined) {
      const size = await svc.screenSize();
      regionW = size.width;
      regionH = size.height;
    }
    const scaleX = outW && regionW ? outW / regionW : 1;
    const scaleY = outH && regionH ? outH / regionH : 1;
    mappingText = JSON.stringify({
      coordinateMapping:
        "desktopX = regionX + imageX / scaleX; desktopY = regionY + imageY / scaleY",
      regionX,
      regionY,
      desktopWidth: regionW,
      desktopHeight: regionH,
      imageWidth: outW,
      imageHeight: outH,
      scaleX: Number(scaleX.toFixed(4)),
      scaleY: Number(scaleY.toFixed(4)),
      note:
        "This image is downscaled by scaleX/scaleY. Multiply an image pixel by 1/scale (and add regionX/regionY) to get the absolute desktop coordinate to pass to clickAt. If grid=true, the printed grid labels are ALREADY these desktop coordinates — read them directly.",
    });
  } catch {
    // sharp is optional; fall back to image-only if metadata can't be read.
  }

  const parts: (
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  )[] = [];
  if (mappingText) parts.push({ type: "text", text: mappingText });
  parts.push({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${b64}` },
  });
  return parts;
}

export async function computerUseScreenshotRegion(
  this: ToolsService,
  x: number,
  y: number,
  width: number,
  height: number,
  displayId?: number,
  grid?: boolean
): Promise<
  (
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  )[]
> {
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
  // Attach an exact pixel->desktop coordinate mapping so the agent never has to
  // GUESS the output size or scale. It measures a target's pixel position in the
  // returned image, then applies these constants to get an absolute desktop
  // coordinate it can pass straight to clickAt.
  let mappingText: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    const meta = await sharp(buf).metadata();
    const outW = meta.width || width;
    const outH = meta.height || height;
    const scaleX = outW / width;
    const scaleY = outH / height;
    mappingText = JSON.stringify({
      coordinateMapping:
        "desktopX = regionX + imageX / scaleX; desktopY = regionY + imageY / scaleY",
      regionX: x,
      regionY: y,
      imageWidth: outW,
      imageHeight: outH,
      scaleX: Number(scaleX.toFixed(4)),
      scaleY: Number(scaleY.toFixed(4)),
      note:
        "Pass the resulting desktop x/y directly to clickAt. Do not add any extra offset or scale. If grid=true, the printed grid labels are already these desktop coordinates.",
    });
  } catch {
    // sharp is optional; fall back to image-only if metadata can't be read.
  }
  const parts: (
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  )[] = [];
  if (mappingText) parts.push({ type: "text", text: mappingText });
  parts.push({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${b64}` },
  });
  return parts;
}

export async function computerUseGetPixelColor(
  this: ToolsService,
  x: number,
  y: number
): Promise<string> {
  return getService(this).pixelColor({ x, y });
}

export async function computerUseFindColorRegions(
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

export async function computerUseClickColorSequence(
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

export async function computerUseGetMousePosition(this: ToolsService): Promise<string> {
  return JSON.stringify(await getService(this).mousePosition());
}

// ── windows ────────────────────────────────────────────────────────────────

export async function computerUseListWindows(this: ToolsService): Promise<string> {
  const windows = await getService(this).listWindows();
  if (!windows.length)
    return "No windows found (or window listing unsupported on this platform/session).";
  return windows
    .map((w) => `- ${w.app ? `[${w.app}] ` : ""}${w.title}`)
    .join("\n");
}

export async function computerUseGetActiveWindow(this: ToolsService): Promise<string> {
  const w = await getService(this).getActiveWindow();
  return w ? JSON.stringify(w) : "No active window.";
}

export async function computerUseFocusWindow(
  this: ToolsService,
  match: string
): Promise<string> {
  const ok = await getService(this).focusWindow(match);
  return ok ? `Focused/activated: ${match}` : `Could not focus: ${match}`;
}

// ── mouse ──────────────────────────────────────────────────────────────────

type ImagePart = { type: "image_url"; image_url: { url: string } };
type TextPart = { type: "text"; text: string };
type VisualFeedbackPart = ImagePart | TextPart;

export interface ActionVisualFeedbackOptions {
  /** Enabled by default. Set false to preserve the legacy text-only response. */
  enabled?: boolean;
  before?: { width?: number; height?: number; scale?: number };
  after?: {
    width?: number;
    height?: number;
    scale?: number;
    /** An absolute desktop region. Overrides width/height and window detection. */
    region?: Region;
  };
  /** Time to wait for UI updates before capturing the after image (default 100ms). */
  delayMs?: number;
  /** Omit the after image when its encoded pixels exactly match the pre-click context. */
  omitUnchanged?: boolean;
}

function imagePart(buffer: Buffer): ImagePart {
  const isPng =
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  return {
    type: "image_url",
    image_url: {
      url: `data:image/${isPng ? "png" : "jpeg"};base64,${buffer.toString(
        "base64"
      )}`,
    },
  };
}

function intersectRegion(region: Region, bounds: Region): Region {
  const left = Math.max(region.x, bounds.x);
  const top = Math.max(region.y, bounds.y);
  const right = Math.min(region.x + region.width, bounds.x + bounds.width);
  const bottom = Math.min(region.y + region.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) {
    throw new Error("Visual feedback region does not intersect the target display.");
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function centeredRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  displayBounds: Region
): Region {
  const boundedWidth = Math.min(displayBounds.width, Math.max(32, width));
  const boundedHeight = Math.min(displayBounds.height, Math.max(32, height));
  const left = Math.min(
    displayBounds.x + displayBounds.width - boundedWidth,
    Math.max(displayBounds.x, Math.round(x - boundedWidth / 2))
  );
  const top = Math.min(
    displayBounds.y + displayBounds.height - boundedHeight,
    Math.max(displayBounds.y, Math.round(y - boundedHeight / 2))
  );
  return { x: left, y: top, width: boundedWidth, height: boundedHeight };
}

async function beforeFeedbackRegion(
  svc: ComputerUseService,
  x: number,
  y: number,
  feedback: ActionVisualFeedbackOptions
): Promise<{ before: Region; displayBounds: Region }> {
  const displays = await svc.getDisplays();
  const display =
    displays.find(
      (candidate) =>
        x >= candidate.bounds.x &&
        y >= candidate.bounds.y &&
        x < candidate.bounds.x + candidate.bounds.width &&
        y < candidate.bounds.y + candidate.bounds.height
    ) || displays.find((candidate) => candidate.primary);
  const displayBounds =
    display?.bounds || ({ x: 0, y: 0, ...(await svc.screenSize()) } as Region);
  const before = centeredRegion(
    x,
    y,
    feedback.before?.width ?? 240,
    feedback.before?.height ?? 240,
    displayBounds
  );
  return { before, displayBounds };
}

async function afterFeedbackRegion(
  svc: ComputerUseService,
  x: number,
  y: number,
  feedback: ActionVisualFeedbackOptions,
  clickedDisplayBounds: Region
): Promise<Region> {
  if (feedback.after?.region) {
    return intersectRegion(feedback.after.region, clickedDisplayBounds);
  }
  if (feedback.after?.width || feedback.after?.height) {
    return centeredRegion(
      x,
      y,
      feedback.after.width ?? 1200,
      feedback.after.height ?? 900,
      clickedDisplayBounds
    );
  }

  try {
    const activeBounds = (await svc.getActiveWindow())?.bounds;
    if (activeBounds) {
      const displays = await svc.getDisplays();
      const activeDisplay = displays.find((display) => {
        const bounds = display.bounds;
        return (
          activeBounds.x < bounds.x + bounds.width &&
          activeBounds.x + activeBounds.width > bounds.x &&
          activeBounds.y < bounds.y + bounds.height &&
          activeBounds.y + activeBounds.height > bounds.y
        );
      });
      if (activeDisplay) {
        return intersectRegion(activeBounds, activeDisplay.bounds);
      }
    }
  } catch {
    // Window discovery is optional; the clicked display is a safe fallback.
  }
  return clickedDisplayBounds;
}

export async function computerUseMoveMouse(
  this: ToolsService,
  x: number,
  y: number
): Promise<string> {
  await getService(this).moveMouse({ x, y });
  return `Moved mouse to (${x}, ${y})`;
}

export async function computerUseClick(
  this: ToolsService,
  button?: "left" | "right" | "middle"
): Promise<string> {
  await getService(this).click(button ?? "left");
  return `Clicked ${button ?? "left"}`;
}

export async function computerUseDoubleClick(
  this: ToolsService,
  button?: "left" | "right" | "middle"
): Promise<string> {
  await getService(this).click(button ?? "left", { double: true });
  return `Double-clicked ${button ?? "left"}`;
}

export async function computerUseClickAt(
  this: ToolsService,
  x: number,
  y: number,
  button?: "left" | "right" | "middle",
  feedback: ActionVisualFeedbackOptions = {}
): Promise<string | VisualFeedbackPart[]> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      "clickAt requires finite lowercase `x` and `y` coordinates."
    );
  }
  const svc = getService(this);
  await svc.moveMouse({ x, y });

  if (feedback?.enabled === false) {
    await svc.click(button ?? "left");
    return `Clicked ${button ?? "left"} at (${x}, ${y})`;
  }

  const { before: beforeRegion, displayBounds } = await beforeFeedbackRegion(
    svc,
    x,
    y,
    feedback || {}
  );
  const beforeScale = feedback?.before?.scale ?? 1;
  const afterScale = feedback?.after?.scale ?? 0.25;
  const before = await svc.screenshot({
    region: beforeRegion,
    scale: beforeScale,
  });
  const beforeContextRegion = feedback?.omitUnchanged
    ? await afterFeedbackRegion(svc, x, y, feedback, displayBounds)
    : undefined;
  const beforeContext = beforeContextRegion
    ? await svc.screenshot({ region: beforeContextRegion, scale: afterScale })
    : undefined;

  await svc.click(button ?? "left");
  const delayMs = Math.min(5000, Math.max(0, feedback?.delayMs ?? 100));
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const afterRegion = await afterFeedbackRegion(
    svc,
    x,
    y,
    feedback,
    displayBounds
  );
  const after = await svc.screenshot({
    region: afterRegion,
    scale: afterScale,
  });
  const sameContext =
    !!beforeContextRegion &&
    beforeContextRegion.x === afterRegion.x &&
    beforeContextRegion.y === afterRegion.y &&
    beforeContextRegion.width === afterRegion.width &&
    beforeContextRegion.height === afterRegion.height;
  const afterUnchanged =
    !!beforeContext &&
    sameContext &&
    beforeContext.length === after.length &&
    beforeContext.equals(after);

  const metadata = {
    action: "clickAt",
    button: button ?? "left",
    point: { x, y },
    coordinateSpace: "absolute-desktop-pixels",
    before: { bounds: beforeRegion, scale: beforeScale },
    after: {
      bounds: afterRegion,
      scale: afterScale,
      omitted: afterUnchanged,
    },
    delayMs,
  };
  const parts: VisualFeedbackPart[] = [
    { type: "text", text: JSON.stringify(metadata) },
    { type: "text", text: "Before click (tight crop):" },
    imagePart(before),
  ];
  if (!afterUnchanged) {
    parts.push(
      { type: "text", text: "After click (context crop):" },
      imagePart(after)
    );
  }
  return parts;
}

export async function computerUseDragMouse(
  this: ToolsService,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<string> {
  await getService(this).drag({ x: fromX, y: fromY }, { x: toX, y: toY });
  return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
}

export async function computerUseScroll(
  this: ToolsService,
  dx: number,
  dy: number
): Promise<string> {
  await getService(this).scroll(dx, dy);
  return `Scrolled (dx=${dx}, dy=${dy})`;
}

export async function computerUseSmoothScroll(
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

export async function computerUseTypeText(
  this: ToolsService,
  text: string
): Promise<string> {
  await getService(this).typeText(text);
  return `Typed ${text.length} chars`;
}

export async function computerUsePressKey(
  this: ToolsService,
  key: string
): Promise<string> {
  await getService(this).pressKey(key);
  return `Pressed ${key}`;
}

export async function computerUseHotkey(
  this: ToolsService,
  keys: string[]
): Promise<string> {
  await getService(this).hotkey(...keys);
  return `Hotkey ${keys.join("+")}`;
}

// ── batch / macro ───────────────────────────────────────────────────────────

export async function computerUseRunComputerMacro(
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

export async function computerUseRunComputerMacroFile(
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

// ── perception: boxes / shapes / blobs ───────────────────────────────────────

export async function computerUseFindBoxes(
  this: ToolsService,
  region?: { x: number; y: number; width: number; height: number } | string,
  minSize?: number,
  maxSize?: number,
  minEdgeScore?: number,
  edgeThreshold?: number,
  maxBoxes?: number,
  displayId?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const resolved = resolveRegion(region as any);
  const boxes = await svc.findBoxes({
    region: resolved,
    minSize,
    maxSize,
    minEdgeScore,
    edgeThreshold,
    maxBoxes,
    displayId,
  });
  return JSON.stringify(boxes, null, 2);
}

export async function computerUseFindShape(
  this: ToolsService,
  kind: "line-h" | "line-v" | "rect" | "square" | "circle" | "blob",
  color?: string,
  region?: { x: number; y: number; width: number; height: number } | string,
  tolerance?: number,
  minSize?: number,
  maxSize?: number,
  length?: number,
  thickness?: number,
  displayId?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const resolved = resolveRegion(region as any);
  const shapes = await svc.findShapes({
    kind,
    color,
    region: resolved,
    tolerance,
    minSize,
    maxSize,
    length,
    thickness,
    displayId,
  });
  return JSON.stringify(shapes, null, 2);
}

// ── region registry ──────────────────────────────────────────────────────────

export async function computerUseDefineRegion(
  this: ToolsService,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<string> {
  const region = defineRegion(name, { x, y, width, height });
  return `Defined region "${name}": ${JSON.stringify(region)}`;
}

export async function computerUseListRegions(this: ToolsService): Promise<string> {
  const regions = listRegions();
  const names = Object.keys(regions);
  if (!names.length) return "No named regions defined.";
  return JSON.stringify(regions, null, 2);
}

export async function computerUseClearRegion(
  this: ToolsService,
  name: string
): Promise<string> {
  const ok = clearRegion(name);
  return ok ? `Cleared region "${name}".` : `No region named "${name}".`;
}

// ── automations ──────────────────────────────────────────────────────────────

/**
 * Author + persist an automation: a local perception→action loop the agent
 * writes ONCE (after watching the game/UI) and then launches with a single
 * tool call. The `script` is a .ts async body with an injected `sdk` object
 * (perception + mouse/keyboard + control). Its editor-only SDK import is
 * allowed, while all other module access remains forbidden. Repeated work is
 * scoped explicitly with `await sdk.runEvery(callback, intervalMs)`.
 */
export async function computerUseWriteAutomation(
  this: ToolsService,
  name: string,
  script: string
): Promise<string> {
  if (!name || !script) {
    throw new Error("writeAutomation requires a name and a script body.");
  }
  validateScript(script);
  const spec: AutomationSpec = { name, script };
  const saved = saveAutomation(spec);
  const missingDoc = !saved.doc || !saved.doc.useWhen;
  return (
    `Saved automation "${name}" (${script.length} chars) as ${name}.ts. ` +
    `File: ${saved.filePath}. ` +
    `Import { sdk } from "@tyvm/knowhow-module-computer-use" for editor types, then use await sdk.runEvery(callback, intervalMs).` +
    ` Run it with computerUseRunAutomation("${name}"), or dry-run first with computerUseTestAutomation("${name}").` +
    (missingDoc
      ? ` Warning: no discoverable header found. Add a leading JSDoc block comment at the top with @description, @useWhen, @startState, @endState, and @window tags so a future agent knows WHEN to use this automation without reading its code.`
      : ` Parsed skill header: ${JSON.stringify(saved.doc)}.`) +
    (!script.includes("sdk.requiredWindow(") && !/requiredWindow\s*:/.test(script)
      ? " Warning: no required-window gate was found (neither sdk.requiredWindow(...) nor a { requiredWindow } option on sdk.runEvery). Without it, clicking away will NOT auto-pause the automation and a human can't easily reclaim the mouse. Note runs are hard-capped at 10s regardless."
      : "")
  );
}

export async function computerUseListAutomations(
  this: ToolsService
): Promise<string> {
  const specs = listAutomations();
  if (!specs.length) return "No automations defined.";
  const runningNow = new Set(listRunning());
  return JSON.stringify(
    specs.map((s) => ({
      name: s.name,
      file: s.filePath || `${s.name}.ts`,
      running: runningNow.has(s.name),
      doc: s.doc || null,
      documented: !!(s.doc && s.doc.useWhen),
      scriptChars: s.script.length,
    })),
    null,
    2
  );
}

function summarizeRun(result: any): string {
  const clicks = result.actions.filter(
    (a: any) => a.kind === "clickAt" && !a.suppressed
  );
  const suppressed = result.actions.filter((a: any) => a.suppressed);
  const intervals: number[] = [];
  for (let i = 1; i < clicks.length; i++) {
    intervals.push(clicks[i].t - clicks[i - 1].t);
  }
  const avgInterval = intervals.length
    ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
    : null;
  return JSON.stringify(
    {
      name: result.name,
      dryRun: result.dryRun,
      stopped: result.stopped,
      error: result.error,
      elapsedMs: result.elapsedMs,
      pausedMs: result.pausedMs,
      actionCount: result.actionCount,
      clicks: clicks.length,
      suppressedActions: suppressed.length,
      avgClickIntervalMs: avgInterval,
      requiredWindow: result.requiredWindow || null,
      ranWithoutWindowGate: !!result.ranWithoutWindowGate,
      warning: result.ranWithoutWindowGate
        ? "This live run moved the real mouse WITHOUT a required-window gate, so a human could not reclaim control by clicking away. Add await sdk.requiredWindow({ titleIncludes }) (or pass { requiredWindow } to sdk.runEvery) before re-running."
        : undefined,
      logs: result.logs.slice(-40),
    },
    null,
    2
  );
}

export async function computerUseRunAutomation(
  this: ToolsService,
  name: string,
  maxDurationMs?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const spec = loadAutomation(name);
  if (getRunning(name)) {
    return `Automation "${name}" is already running. Stop it first with computerUseStopAutomation("${name}").`;
  }
  const runner = new AutomationRunner(spec, svc, { maxDurationMs });
  const result = await runner.run();
  return summarizeRun(result);
}

/**
 * Dry-run an automation against LIVE perception without moving the real mouse.
 * Perception reads real pixels, but every clickAt/moveMouse/type is RECORDED
 * instead of performed, so you can verify the automation targets the right
 * spots (and how fast) before letting it act for real. Use this on the game to
 * confirm it's locking onto the target before switching to computerUseRunAutomation.
 */
export async function computerUseTestAutomation(
  this: ToolsService,
  name: string,
  maxDurationMs?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const spec = loadAutomation(name);
  const runner = new AutomationRunner(spec, svc, {
    maxDurationMs: maxDurationMs ?? 8000,
    dryRun: true,
  });
  const result = await runner.run();
  return summarizeRun(result);
}

export async function computerUseStopAutomation(
  this: ToolsService,
  name: string
): Promise<string> {
  const runner = getRunning(name);
  if (!runner) return `Automation "${name}" is not running.`;
  runner.ctl.stop();
  return `Requested stop for automation "${name}".`;
}

export async function computerUseDeleteAutomation(
  this: ToolsService,
  name: string
): Promise<string> {
  const runner = getRunning(name);
  if (runner) runner.ctl.stop();
  const ok = deleteAutomation(name);
  return ok ? `Deleted automation "${name}".` : `No automation named "${name}".`;
}
