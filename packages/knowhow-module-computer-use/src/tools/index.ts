import { ComputerUseService } from "@tyvm/knowhow";
import {
  ClickColorSequenceOptions,
  ComputerService,
  ReadTextOptions,
  appNameMatches,
} from "../ComputerService";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import { ExtensionsService } from "@tyvm/knowhow/ts_build/src/services/ExtensionsService";
import { Region } from "@tyvm/knowhow/ts_build/src/services/modules/computerUse";
import * as fs from "fs";
import { runMacro, MacroStep, parseMacroFile } from "../macro";
import {
  defineRegion,
  listRegions,
  clearRegion,
  resolveRegionAsync,
  regionContainsPointAsync,
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
import { AUTOMATION_SDK_EXTENSION, AutomationSdkExtension } from "../automationExtensions";

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

/**
 * Resolve the ExtensionsService from the ToolsService context. Gracefully
 * absent: returns undefined when running standalone (e.g. knowhow computer CLI
 * without a full services setup).
 */
function getExtensions(self: unknown): ExtensionsService | undefined {
  const toolService = self as ToolsService | undefined;
  if (!toolService || typeof toolService.getContext !== "function") return undefined;
  const ctx = toolService.getContext() as any;
  return ctx?.Extensions instanceof ExtensionsService ? ctx.Extensions : undefined;
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
  if (scale !== undefined) opts.captureScale = scale;

  let buf: Buffer;
  try {
    if ((grid || crosshair) && typeof svc.screenshotAnnotated === "function") {
      if (grid) opts.grid = true;
      if (crosshair) opts.crosshair = crosshair;
      buf = await svc.screenshotAnnotated(opts);
    } else {
      buf = await svc.screenshot(Object.keys(opts).length ? opts : undefined);
    }
  } catch (error) {
    const domain = displayId === undefined ? "the virtual desktop" : `display ${displayId}`;
    const crop = region ? ` region ${JSON.stringify(region)}` : "";
    const message = error instanceof Error ? error.message : String(error);
    return `Capture failed for ${domain}${crop}: ${message}. ` +
      "Confirm the display ID with computerUseGetDisplays and keep the region inside that display's bounds.";
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
  const mappingText = JSON.stringify({
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

/** Capture a verified window as a row-major set of native-resolution tiles. */
export async function computerUseScreenshotWindowTiles(
  this: ToolsService, windowId: number, columns = 2, rows = 2
): Promise<(TextPart | ImagePart)[]> {
  const service = getService(this) as any;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns > 8 || rows > 8)
    throw new Error("Tile columns and rows must be integers between 1 and 8");
  const listed = (await service.listWindows()).find((candidate: any) => candidate.id === windowId);
  if (!listed?.bounds) throw new Error(`Unknown, stale, or unbounded window ID: ${windowId}`);
  if (!(await service.focusWindowById(windowId))) throw new Error(`Could not focus window ID ${windowId}`);
  const active = await requireExpectedWindow(service, undefined, windowId);
  if (!active?.bounds || JSON.stringify(active.bounds) !== JSON.stringify(listed.bounds))
    throw new Error(`Window ID ${windowId} is stale or changed geometry while focusing`);
  const current = (await service.listWindows()).find((candidate: any) => candidate.id === windowId);
  const bounds = current?.bounds;
  if (!bounds || JSON.stringify(bounds) !== JSON.stringify(listed.bounds))
    throw new Error(`Window ID ${windowId} changed geometry while focusing; retry with a fresh window ID`);
  const displays = await service.getDisplays();
  const display = displays.find((d: any) => {
    const b = d.bounds;
    return b && bounds.x >= b.x && bounds.y >= b.y && bounds.x + bounds.width <= b.x + b.width && bounds.y + bounds.height <= b.y + b.height;
  });
  if (!display) throw new Error(`Window ID ${windowId} is clipped or crosses display boundaries`);
  const parts: (TextPart | ImagePart)[] = [];
  const tiles: any[] = [];
  const sharp = require("sharp");
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const left = Math.floor(bounds.width * col / columns);
    const top = Math.floor(bounds.height * row / rows);
    const right = Math.floor(bounds.width * (col + 1) / columns);
    const bottom = Math.floor(bounds.height * (row + 1) / rows);
    const region = { x: bounds.x + left, y: bounds.y + top, width: right - left, height: bottom - top };
    if (region.width < 1 || region.height < 1) throw new Error("Window is too small for requested tile grid");
    const buf = await service.screenshot({ displayId: display.id, region, captureScale: 1, scale: 1 });
    const meta = await sharp(buf).metadata();
    tiles.push({ order: tiles.length, row, column: col, windowId, windowTitle: current.title, application: current.app,
      displayId: display.id, displayBounds: display.bounds, absoluteBounds: region, absoluteDesktopBounds: region,
      windowRelativeBounds: { x: left, y: top, width: region.width, height: region.height },
      imageWidth: meta.width, imageHeight: meta.height, imageDimensions: { width: meta.width, height: meta.height },
      scaleX: (meta.width || 0) / region.width, scaleY: (meta.height || 0) / region.height,
      imageScale: { x: (meta.width || 0) / region.width, y: (meta.height || 0) / region.height } });
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } });
  }
  parts.unshift({ type: "text", text: JSON.stringify({ windowId, windowBounds: bounds, windowTitle: current.title, application: current.app,
    displayId: display.id, displayBounds: display.bounds, columns, rows, tileCount: tiles.length, tiles }) });
  return parts;
}

export async function computerUseScreenshotWindow(
  this: ToolsService,
  windowId: number,
  grid?: boolean
): Promise<({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[]> {
  const service = getService(this) as ComputerService;
  const window = (await service.listWindows()).find(candidate => candidate.id === windowId);
  if (!window?.bounds) throw new Error(`Unknown, stale, or unbounded window ID: ${windowId}`);
  if (!(await service.focusWindowById(windowId))) throw new Error(`Could not focus window ID ${windowId}`);
  await requireExpectedWindow(service, undefined, windowId);
  const { x, y, width, height } = window.bounds;
  const parts = await computerUseScreenshotRegion.call(this, x, y, width, height, undefined, grid);
  const metadata = JSON.parse((parts[0] as { type: "text"; text: string }).text);
  metadata.windowId = windowId;
  metadata.windowBounds = window.bounds;
  metadata.windowTitle = window.title;
  metadata.application = window.app;
  (parts[0] as { type: "text"; text: string }).text = JSON.stringify(metadata);
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
  if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2)
    throw new Error("Screenshot region must use finite coordinates and dimensions of at least 2x2");
  const displays = await svc.getDisplays();
  const containingDisplay = displays.find((display: any) => {
    const bounds = display.bounds;
    return x >= bounds.x && y >= bounds.y &&
      x + width <= bounds.x + bounds.width &&
      y + height <= bounds.y + bounds.height;
  });
  if (!containingDisplay)
    throw new Error(
      `Requested region ${JSON.stringify({ x, y, width, height })} is not fully contained in one display; ` +
      "cross-display and clipped captures are rejected"
    );
  // Region captures are already bounded and are primarily used for aiming.
  // Keep them at 1:1 desktop pixels so image coordinates remain directly
  // usable as desktop coordinates instead of silently applying the service's
  // bandwidth-oriented default downscale.
  const opts: any = {
    region: { x, y, width, height },
    captureScale: 1,
    scale: 1,
  };
  if (displayId !== undefined) opts.displayId = displayId;
  let buf: Buffer;
  if (grid && typeof svc.screenshotAnnotated === "function") {
    buf = await svc.screenshotAnnotated({ ...opts, grid: true });
  } else {
    buf = await svc.screenshot(opts);
  }
  // Attach an exact pixel->desktop coordinate mapping so the agent never has to
  // GUESS the output size or scale. It measures a target's pixel position in the
  // returned image, then applies these constants to get an absolute desktop
  // coordinate it can pass straight to clickAt.
  let mappingText: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    let meta = await sharp(buf).metadata();
    // HiDPI displays (e.g. a 3008x1692 "looks like" scaled 4K panel) return
    // physical pixels at the display's backing scale. That is an exact uniform
    // scale, not clipping: downsample back to 1:1 desktop pixels so image
    // coordinates stay directly clickable.
    const rawW = meta.width || width;
    const rawH = meta.height || height;
    const ratioX = rawW / width;
    const ratioY = rawH / height;
    if ((rawW !== width || rawH !== height) && ratioX > 1 &&
      Math.abs(ratioX - ratioY) < 0.01 &&
      Math.abs(ratioX - Math.round(ratioX * 4) / 4) < 0.01) {
      buf = await sharp(buf).resize(width, height).png().toBuffer();
      meta = await sharp(buf).metadata();
    }
    const outW = meta.width || width;
    const outH = meta.height || height;
    if (outW !== width || outH !== height) {
      throw new Error(
        `Invalid region capture: requested ${width}x${height} but received ${outW}x${outH}; ` +
        "the capture was clipped or scaled unexpectedly"
      );
    }
    const scaleX = outW / width;
    const scaleY = outH / height;
    mappingText = JSON.stringify({
      coordinateMapping:
        "desktopX = regionX + imageX / scaleX; desktopY = regionY + imageY / scaleY",
      regionX: x,
      regionY: y,
      requestedRegion: { x, y, width, height },
      actualCapturedRegion: { x, y, width: outW, height: outH },
      displayId: containingDisplay.id,
      clipped: false,
      imageWidth: outW,
      imageHeight: outH,
      scaleX: Number(scaleX.toFixed(4)),
      scaleY: Number(scaleY.toFixed(4)),
      note:
        "Pass the resulting desktop x/y directly to clickAt. Do not add any extra offset or scale. If grid=true, the printed grid labels are already these desktop coordinates.",
    });
  } catch (error) {
    // Geometry mismatches are unsafe to aim from; never disguise them as a
    // successful image-only response.
    if (error instanceof Error && error.message.startsWith("Invalid region capture:"))
      throw error;
    // sharp is optional; fall back to image-only if metadata can't be read.
  }
  const parts: (
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  )[] = [];
  if (mappingText) parts.push({ type: "text", text: mappingText });
  const b64 = buf.toString("base64");
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

/** Read visible text with macOS Vision OCR and return concise desktop-coordinate results. */
export async function computerUseReadText(
  this: ToolsService,
  regionOrOptions?: Region | string | ReadTextOptions,
  displayId?: number,
  activeWindow?: boolean,
  minConfidence?: number,
  recognitionLevel?: "fast" | "accurate"
): Promise<string> {
  const svc = getService(this) as ComputerService;
  // Accept an options object as well as positional properties. The former is
  // convenient for programmatic callers; the latter matches the tool schema.
  const options = regionOrOptions && typeof regionOrOptions === "object" &&
    ("displayId" in regionOrOptions || "activeWindow" in regionOrOptions ||
      "minConfidence" in regionOrOptions || "recognitionLevel" in regionOrOptions ||
      "region" in regionOrOptions)
    ? regionOrOptions as ReadTextOptions
    : { region: regionOrOptions as Region | string | undefined, displayId, activeWindow, minConfidence, recognitionLevel };
  const results = await svc.readText({
    ...options,
  } satisfies ReadTextOptions);
  return JSON.stringify(results.map(({ text, confidence, bounds, center }) => ({
    text, confidence, bounds, center,
  })));
}

/** Sample all requested points from one frame for consistent, low-latency colors. */
export async function computerUseGetPixelColors(
  this: ToolsService,
  points: Array<{ x: number; y: number }>
): Promise<string> {
  return JSON.stringify(await (getService(this) as ComputerService).pixelColors(points));
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
    .map((w) => JSON.stringify(w))
    .join("\n");
}

export async function computerUseGetActiveWindow(this: ToolsService): Promise<string> {
  const w = await getService(this).getActiveWindow();
  return w ? JSON.stringify(w) : "No active window.";
}

export async function computerUseAccessibilityElements(
  this: ToolsService,
  maxDepth?: number,
  maxElements?: number,
  interactiveOnly?: boolean,
  expectedWindowId?: number
): Promise<string> {
  const service = getService(this);
  await requireExpectedWindow(service, undefined, expectedWindowId);
  if (!(await service.accessibilityTrusted())) {
    throw new Error("macOS Accessibility permission is not granted");
  }
  return JSON.stringify(
    await service.accessibilityElements({ maxDepth, maxElements, interactiveOnly }),
    null,
    2
  );
}

export async function computerUseSetAccessibilityValue(
  this: ToolsService,
  id: string,
  value: string
): Promise<string> {
  await getService(this).setAccessibilityValue(id, value);
  return `Set accessibility value for ${id}`;
}

export async function computerUseSelectAccessibilityOption(
  this: ToolsService,
  id: string,
  option: string
): Promise<string> {
  await getService(this).selectAccessibilityOption(id, option);
  return `Selected ${option} for ${id}`;
}

export async function computerUseActivateAccessibilityElement(
  this: ToolsService,
  id: string,
  expectedText?: string
): Promise<string> {
  const service = getService(this);
  const elements = await service.accessibilityElements({
    interactiveOnly: true,
    maxElements: 1000,
  });
  const element = elements.find((candidate) => candidate.id === id);
  if (!element) throw new Error(`Unknown or stale accessibility ID: ${id}`);
  if (expectedText) {
    const semanticText = `${element.title ?? ""} ${element.description ?? ""} ${element.value ?? ""}`.toLowerCase();
    if (!semanticText.includes(expectedText.toLowerCase())) {
      throw new Error(`Stale or mismatched accessibility ID ${id}: expected text ${JSON.stringify(expectedText)}, found ${JSON.stringify(semanticText.trim())}`);
    }
  }

  const actions = element.actions ?? [];
  const action = ["AXPress", "AXConfirm", "AXPick"].find((candidate) =>
    actions.includes(candidate)
  );
  if (action) {
    await service.performAccessibilityAction(id, action);
    return `Performed ${action} on ${id}`;
  }

  const { bounds } = element;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error(`Element ${id} has no activatable action or usable bounds`);
  }
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  await service.moveMouse(center);
  await service.click("left");
  return `Clicked bounds center of ${id} at (${center.x}, ${center.y})`;
}

export async function computerUsePerformAccessibilityAction(
  this: ToolsService,
  id: string,
  action: string
): Promise<string> {
  await getService(this).performAccessibilityAction(id, action);
  return `Performed ${action} on ${id}`;
}

export async function computerUseFocusWindow(
  this: ToolsService,
  match: string
): Promise<string> {
  const ok = await getService(this).focusWindow(match);
  return ok ? `Focused/activated: ${match}` : `Could not focus: ${match}`;
}

export async function computerUseFocusWindowById(
  this: ToolsService,
  windowId: number
): Promise<string> {
  const service = getService(this) as ComputerService;
  const ok = await service.focusWindowById(windowId);
  return ok
    ? `Focused and verified window ID ${windowId}`
    : `Could not focus and verify window ID ${windowId}`;
}

export async function computerUseGetActiveBrowserTab(this: ToolsService): Promise<string> {
  const service = getService(this) as ComputerService;
  return JSON.stringify(await service.getActiveBrowserTab());
}

export async function computerUseNavigateActiveBrowser(
  this: ToolsService,
  url: string,
  expectedWindowId?: number
): Promise<string> {
  const service = getService(this) as ComputerService;
  return JSON.stringify(await service.navigateActiveBrowser(url, expectedWindowId));
}

// ── mouse ──────────────────────────────────────────────────────────────────

type ImagePart = { type: "image_url"; image_url: { url: string } };
type TextPart = { type: "text"; text: string };
type VisualFeedbackPart = ImagePart | TextPart;

async function requireExpectedWindow(
  svc: ComputerUseService,
  expectedWindow?: string,
  expectedWindowId?: number
): Promise<Awaited<ReturnType<ComputerUseService["getActiveWindow"]>>> {
  const active = await svc.getActiveWindow();
  const activeWithId = active as (typeof active & { id?: number });
  if (expectedWindowId !== undefined && activeWithId?.id !== expectedWindowId) {
    throw new Error(`Refusing input: expected active window ID ${expectedWindowId}, but found ${activeWithId ? JSON.stringify({ id: activeWithId.id, app: activeWithId.app, title: activeWithId.title }) : "no active window"}`);
  }
  if (!expectedWindow) return active;
  const needle = expectedWindow.toLowerCase();
  if (!active || !`${active.app ?? ""} ${active.title}`.toLowerCase().includes(needle)) {
    throw new Error(
      `Refusing input: expected active window containing ${JSON.stringify(expectedWindow)}, ` +
      `but found ${active ? JSON.stringify({ app: active.app, title: active.title }) : "no active window"}`
    );
  }
  return active;
}

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
  feedback: ActionVisualFeedbackOptions = {},
  expectedWindow?: string,
  expectedWindowId?: number,
  app?: string
): Promise<string | VisualFeedbackPart[]> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      "clickAt requires finite lowercase `x` and `y` coordinates."
    );
  }
  const svc = getService(this);
  await activateInputTarget(svc, "coordinate click", app, expectedWindowId);
  const activeWindowBefore = await requireExpectedWindow(svc, expectedWindow, expectedWindowId);
  await svc.moveMouse({ x, y });

  if (feedback?.enabled === false) {
    await svc.click(button ?? "left");
    const activeWindowAfter = await requireExpectedWindow(svc, expectedWindow, expectedWindowId);
    return `Clicked ${button ?? "left"} at (${x}, ${y}); active window before/after: ` +
      `${activeWindowBefore?.title ?? "unknown"} / ${activeWindowAfter?.title ?? "unknown"}`;
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
  const activeWindowAfter = await requireExpectedWindow(svc, expectedWindow, expectedWindowId);

  const metadata = {
    action: "clickAt",
    button: button ?? "left",
    point: { x, y },
    coordinateSpace: "absolute-desktop-pixels",
    expectedWindow,
    activeWindowBefore,
    activeWindowAfter,
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

/**
 * Keystrokes and clicks go to the frontmost app. Instead of hoping the right
 * app is in front, the caller names the app it intends to drive (and
 * optionally an exact window ID). We activate that target first and verify it
 * is frontmost, so input can never silently land in another app (e.g. the
 * terminal running the agent). Naming the terminal itself (app: "Ghostty") is
 * fine when that is genuinely the target.
 */
export async function activateInputTarget(
  svc: ComputerUseService,
  action: string,
  app?: string,
  windowId?: number
): Promise<Awaited<ReturnType<ComputerUseService["getActiveWindow"]>>> {
  const wantedApp = typeof app === "string" && app.trim() ? app.trim() : undefined;
  if (!wantedApp && windowId === undefined) {
    throw new Error(
      `Refusing ${action} without a target: pass \`app\` (the application name from computerUseListWindows, ` +
      `e.g. "Obsidian" or "Google Chrome"). It is activated before input so keystrokes land in the right app.`
    );
  }
  const describe = (w: any) => w ? JSON.stringify({ id: w.id, app: w.app, title: w.title }) : "no active window";
  const isTarget = (w: any) =>
    !!w && (windowId === undefined || w.id === windowId) && (!wantedApp || appNameMatches(w.app, wantedApp));

  let active = await svc.getActiveWindow();
  if (isTarget(active)) return active;

  const service = svc as any;
  if (windowId !== undefined) {
    if (typeof service.focusWindowById !== "function" || !(await service.focusWindowById(windowId))) {
      throw new Error(`Refusing ${action}: could not activate window ID ${windowId}; active window is ${describe(active)}`);
    }
  } else if (typeof service.activateApp === "function") {
    if (!(await service.activateApp(wantedApp))) {
      throw new Error(`Refusing ${action}: could not activate app ${JSON.stringify(wantedApp)}; active window is ` +
        `${describe(await svc.getActiveWindow())}. Check the exact app name with computerUseListWindows.`);
    }
  } else if (typeof service.focusWindow !== "function" || !(await service.focusWindow(wantedApp))) {
    throw new Error(`Refusing ${action}: could not activate app ${JSON.stringify(wantedApp)}`);
  }

  active = await svc.getActiveWindow();
  if (!isTarget(active)) {
    const want = [wantedApp && `app ${JSON.stringify(wantedApp)}`, windowId !== undefined && `window ID ${windowId}`]
      .filter(Boolean).join(" / ");
    throw new Error(`Refusing ${action}: expected ${want} to be frontmost after activating it, but found ${describe(active)}`);
  }
  return active;
}

export async function computerUseTypeText(
  this: ToolsService,
  text: string,
  expectedWindow?: string,
  requireEditableFocus?: boolean,
  expectedWindowId?: number,
  app?: string
): Promise<string> {
  const svc = getService(this);
  await activateInputTarget(svc, "text input", app, expectedWindowId);
  const activeWindow = await requireExpectedWindow(svc, expectedWindow, expectedWindowId);
  let focusNote = "";
  if (requireEditableFocus) {
    const elements = await svc.accessibilityElements({
      interactiveOnly: false,
      maxElements: 1000,
    });
    const focused = elements.find(element => element.focused);
    const editableRoles = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);
    if (!focused) {
      // Electron/web apps (Obsidian, Slack, VS Code, …) often expose no focused
      // AX element at all even when a contenteditable editor has the caret, so
      // "none" means unknown, not "not editable".
      focusNote = " (focused element unknown to accessibility; verify the text landed)";
    } else if (!editableRoles.has(focused.role)) {
      throw new Error(
        `Refusing to type: the focused accessibility element is not editable (` +
        `${focused.role} ${JSON.stringify(focused.title ?? "")})`
      );
    }
  }
  await svc.typeText(text);
  return `Typed ${text.length} chars in ${activeWindow?.app ?? "unknown app"} — ${activeWindow?.title ?? "unknown window"}${focusNote}`;
}

export async function computerUsePressKey(
  this: ToolsService,
  key: string,
  app?: string,
  expectedWindowId?: number
): Promise<string> {
  const svc = getService(this);
  const active = await activateInputTarget(svc, `key press ${key}`, app, expectedWindowId);
  await svc.pressKey(key);
  return `Pressed ${key} in ${active?.app ?? "unknown app"}`;
}

export async function computerUseHotkey(
  this: ToolsService,
  keys: string[],
  app?: string,
  expectedWindowId?: number
): Promise<string> {
  const svc = getService(this);
  const active = await activateInputTarget(svc, `hotkey ${keys.join("+")}`, app, expectedWindowId);
  await svc.hotkey(...keys);
  return `Hotkey ${keys.join("+")} in ${active?.app ?? "unknown app"}`;
}

// ── batch / macro ───────────────────────────────────────────────────────────

export async function computerUseRunComputerMacro(
  this: ToolsService,
  steps: MacroStep[],
  continueOnError?: boolean,
  expectedWindowId?: number,
  app?: string
): Promise<string> {
  const svc = getService(this);
  await activateInputTarget(svc, "macro input", app, expectedWindowId);
  const results = await runMacro(svc, steps, {
    continueOnError: !!continueOnError,
  });
  // A macro may legitimately switch apps via {action:'focus'}; only verify the
  // starting target when the macro didn't do that itself.
  if (!steps.some((step: any) => step?.action === "focus")) {
    const active = await svc.getActiveWindow();
    const ok = !!active && (expectedWindowId === undefined || (active as any).id === expectedWindowId) &&
      (!app || appNameMatches(active.app, app));
    if (!ok) throw new Error(`Macro finished but the target app lost focus; active window is now ${JSON.stringify({ app: active?.app, title: active?.title })}`);
  }
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
  const resolved = await resolveRegionAsync(region as any, () => svc.getActiveWindow());
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

export async function computerUseFindRegions(
  this: ToolsService,
  region?: { x: number; y: number; width: number; height: number } | string,
  mode?: "foreground" | "colors" | "panels",
  minSize?: number,
  colorBits?: number,
  clusterGap?: number,
  minPixels?: number,
  maxBoxes?: number,
  displayId?: number,
  scale?: number
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const resolved = await resolveRegionAsync(region as any, () => svc.getActiveWindow());
  const boxes = await svc.findRegions({
    region: resolved,
    mode: mode ?? "colors",
    minSize,
    colorBits,
    clusterGap,
    minPixels,
    maxBoxes,
    displayId,
    scale,
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
  const resolved = await resolveRegionAsync(region as any, () => svc.getActiveWindow());
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
  height: number,
  anchorToActiveWindow?: boolean,
  titleIncludes?: string
): Promise<string> {
  if (anchorToActiveWindow) {
    const active = await getService(this).getActiveWindow();
    if (!active?.bounds) {
      throw new Error("Cannot anchor region: active window bounds are unavailable");
    }
    const b = active.bounds;
    const region = defineRegion(name, {
      version: 1,
      region: {
        x: (x - b.x) / b.width,
        y: (y - b.y) / b.height,
        width: width / b.width,
        height: height / b.height,
      },
      anchor: {
        coordinateSpace: "window-normalized",
        window: {
          app: (active as { app?: string }).app,
          titleIncludes,
        },
      },
    });
    return `Defined window-relative region "${name}": ${JSON.stringify(region)}`;
  }
  const region = defineRegion(name, { x, y, width, height });
  return `Defined region "${name}": ${JSON.stringify(region)}`;
}

export async function computerUseDefineRegionShape(
  this: ToolsService,
  name: string,
  shape: any
): Promise<string> {
  // shape is a RegionShape object (rect/circle/ellipse/polygon/svgpath/union/
  // subtract). Persist it so detectors/observers can reference it by name and
  // hit-test with the true (non-rect) geometry.
  const parsed = typeof shape === "string" ? JSON.parse(shape) : shape;
  const region = defineRegion(name, parsed);
  return `Defined shape region "${name}" (${parsed.type}): ${JSON.stringify(
    region
  )}`;
}

export async function computerUseRegionContains(
  this: ToolsService,
  name: string,
  x: number,
  y: number
): Promise<string> {
  const svc = getService(this);
  const inside = await regionContainsPointAsync(
    name,
    { x, y },
    () => svc.getActiveWindow()
  );
  return `Point (${x}, ${y}) is ${inside ? "INSIDE" : "OUTSIDE"} region "${name}".`;
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
      ? " Warning: no required-window gate was found (neither sdk.requiredWindow(...) nor a { requiredWindow } option on sdk.runEvery). Without it, clicking away will NOT auto-pause the automation and a human can't easily reclaim the mouse. Note runs are hard-capped at 5 minutes regardless."
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
      artifactCount: result.artifacts?.length ?? 0,
      artifacts: result.artifacts ?? [],
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
  maxDurationMs?: number,
  params?: Record<string, unknown>
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const spec = loadAutomation(name);
  if (getRunning(name)) {
    return `Automation "${name}" is already running. Stop it first with computerUseStopAutomation("${name}").`;
  }
  const runner = new AutomationRunner(spec, svc, {
    maxDurationMs,
    params,
    toolsService: this,
    extensions: getExtensions(this),
  });
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
  maxDurationMs?: number,
  params?: Record<string, unknown>
): Promise<string> {
  const svc = getService(this) as ComputerService;
  const spec = loadAutomation(name);
  const runner = new AutomationRunner(spec, svc, {
    maxDurationMs: maxDurationMs ?? 8000,
    params,
    toolsService: this,
    dryRun: true,
    extensions: getExtensions(this),
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

/**
 * List all registered automation SDK extensions (name, description, typings).
 * Use this to discover what sdk.ext.* APIs are available before writing an
 * automation that uses them.
 */
export async function computerUseListAutomationExtensions(
  this: ToolsService
): Promise<string> {
  const extensions = getExtensions(this);
  if (!extensions) {
    return JSON.stringify({ extensions: [], note: "ExtensionsService not available in this context." }, null, 2);
  }
  const exts = extensions.list(AUTOMATION_SDK_EXTENSION) as unknown as readonly AutomationSdkExtension[];
  if (!exts.length) {
    return JSON.stringify({ extensions: [], note: "No automation SDK extensions are registered." }, null, 2);
  }
  return JSON.stringify({
    extensions: exts.map((e) => ({ name: e.name, description: e.description, typings: e.typings ?? null })),
  }, null, 2);
}
