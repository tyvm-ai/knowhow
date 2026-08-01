import { execFile } from "child_process";
import { promisify } from "util";
import {
  ComputerDriver,
  ComputerUseService,
  DriverCapabilities,
  Display,
  MouseButton,
  Point,
  Region,
  ScreenshotOptions,
  Size,
} from "@tyvm/knowhow";
import { RawScreenshot } from "./drivers/RustCoreDriver";

const execFileAsync = promisify(execFile);

export interface ComputerServiceOptions {
  /** Default screenshot format returned by screenshot()/screenshotBase64(). */
  screenshotFormat?: "png" | "jpeg";
  /** Default downscale factor for screenshots (e.g. 0.5 for 4K displays). */
  screenshotScale?: number;
  /** Pin a driver by name; otherwise the highest-priority capable one wins. */
  driver?: string;
}

export interface ColorRegion {
  color: string;
  /** Center and bounds are desktop coordinates, ready for moveMouse/clickAt. */
  center: Point;
  bounds: Region;
  sampledPixels: number;
}

export interface FindColorRegionsOptions {
  colors: string[];
  displayId?: number;
  tolerance?: number;
  sampleStep?: number;
  minPixels?: number;
  minSize?: number;
  maxSize?: number;
}

export interface ClickColorSequenceOptions extends FindColorRegionsOptions {
  maxClicks?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ClickColorSequenceResult {
  clicks: number;
  elapsedMs: number;
  averageMs: number | null;
  timedOut: boolean;
  targets: Array<ColorRegion & { elapsedMs: number }>;
}

/**
 * The concrete `ComputerUse` service registered into the Knowhow ToolContext.
 *
 * Owns:
 *   - driver registration (base module + any adapter modules) and selection
 *   - coordinate clamping to the virtual desktop
 *   - screenshot encoding/scaling (raw RGBA -> png/jpeg via sharp)
 *   - platform helpers the native core doesn't cover yet (window listing)
 *
 * Adapter modules call `registerDriver()` in their `register()` phase; the base
 * module resolves the active driver lazily on first use (or during `init()`).
 */
export class ComputerService implements ComputerUseService {
  private drivers: ComputerDriver[] = [];
  private active: ComputerDriver | null = null;
  private opts: ComputerServiceOptions;
  private cachedSize: Size | null = null;

  constructor(opts: ComputerServiceOptions = {}) {
    this.opts = {
      screenshotFormat: opts.screenshotFormat ?? "jpeg",
      screenshotScale: opts.screenshotScale ?? 1,
      driver: opts.driver,
    };
  }

  registerDriver(driver: ComputerDriver): void {
    // De-dupe by name (idempotent registration across register/init phases).
    if (this.drivers.some((d) => d.name === driver.name)) return;
    this.drivers.push(driver);
    // A newly-registered driver may outrank the currently-active one; force
    // re-resolution on next use.
    this.active = null;
  }

  listDrivers(): string[] {
    return this.drivers.map((d) => d.name);
  }

  async getDriver(): Promise<ComputerDriver> {
    if (this.active) return this.active;
    if (this.drivers.length === 0) {
      throw new Error(
        "No computer-use driver registered. Ensure the Rust core is built or an adapter module is enabled."
      );
    }

    // Pinned driver wins if present.
    if (this.opts.driver) {
      const pinned = this.drivers.find((d) => d.name === this.opts.driver);
      if (pinned) {
        this.active = pinned;
        return pinned;
      }
    }

    // Otherwise pick the lowest priority number among capable drivers.
    const sorted = [...this.drivers].sort(
      (a, b) => (a.priority ?? 1000) - (b.priority ?? 1000)
    );
    for (const d of sorted) {
      try {
        const caps = await d.capabilities();
        if (caps.input || caps.capture) {
          this.active = d;
          return d;
        }
      } catch {
        // driver failed to report caps; skip it
      }
    }
    // Nothing reported caps; fall back to the highest-priority one so callers
    // get a real (actionable) error from the driver itself.
    this.active = sorted[0];
    return this.active;
  }

  async capabilities(): Promise<DriverCapabilities> {
    return (await this.getDriver()).capabilities();
  }

  async getDisplays(): Promise<Display[]> {
    return (await this.getDriver()).getDisplays();
  }

  async screenSize(): Promise<Size> {
    const size = await (await this.getDriver()).screenSize();
    this.cachedSize = size;
    return size;
  }

  private async clamp(p: Point): Promise<Point> {
    const size = this.cachedSize ?? (await this.screenSize());
    return {
      x: Math.max(0, Math.min(p.x, size.width - 1)),
      y: Math.max(0, Math.min(p.y, size.height - 1)),
    };
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const driver = await this.getDriver();
    const result = await driver.screenshot(opts);
    return this.encode(result, opts);
  }

  /**
   * Locate solid-color UI targets directly in a raw screenshot. Unlike asking a
   * vision model to estimate a point, this returns desktop coordinates that can
   * be clicked without another model/tool round trip. CSS benchmark targets,
   * status indicators, and other flat-color controls are the primary use case.
   */
  async findColorRegions(opts: FindColorRegionsOptions): Promise<ColorRegion[]> {
    if (!opts.colors?.length) throw new Error("At least one color is required.");
    const driver = await this.getDriver();
    const shot = await driver.screenshot(
      opts.displayId === undefined ? undefined : { displayId: opts.displayId }
    );
    let raw = shot as unknown as RawScreenshot;
    if (!raw || (raw as any).__raw !== true) {
      // Adapter drivers may return an encoded image rather than our raw envelope.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require("sharp");
      const decoded = await sharp(shot).ensureAlpha().raw().toBuffer({
        resolveWithObject: true,
      });
      raw = {
        __raw: true,
        width: decoded.info.width,
        height: decoded.info.height,
        data: decoded.data,
      };
    }

    const displays = await driver.getDisplays();
    const display =
      displays.find((d) => opts.displayId !== undefined && d.id === opts.displayId) ??
      displays.find((d) => d.primary) ??
      displays[0];
    const desktop = display?.bounds ?? {
      x: 0,
      y: 0,
      width: raw.width,
      height: raw.height,
    };
    const scaleX = raw.width / Math.max(1, desktop.width);
    const scaleY = raw.height / Math.max(1, desktop.height);
    const tolerance = Math.max(0, Math.min(255, Math.round(opts.tolerance ?? 12)));
    const step = Math.max(1, Math.round(opts.sampleStep ?? 2));
    const minPixels = Math.max(1, Math.round(opts.minPixels ?? 20));
    const parsed = opts.colors.map((color) => {
      const hex = color.replace(/^#/, "");
      if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid color: ${color}`);
      return {
        color: `#${hex.toUpperCase()}`,
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        count: 0,
        minX: raw.width,
        minY: raw.height,
        maxX: -1,
        maxY: -1,
      };
    });

    // Aggregate each requested color. This intentionally avoids image encoding,
    // OCR, and connected-component dependencies in the latency-sensitive loop.
    for (let y = 0; y < raw.height; y += step) {
      for (let x = 0; x < raw.width; x += step) {
        const i = (y * raw.width + x) * 4;
        const r = raw.data[i];
        const g = raw.data[i + 1];
        const b = raw.data[i + 2];
        for (const c of parsed) {
          if (
            Math.abs(r - c.r) <= tolerance &&
            Math.abs(g - c.g) <= tolerance &&
            Math.abs(b - c.b) <= tolerance
          ) {
            c.count++;
            if (x < c.minX) c.minX = x;
            if (y < c.minY) c.minY = y;
            if (x > c.maxX) c.maxX = x;
            if (y > c.maxY) c.maxY = y;
            break;
          }
        }
      }
    }

    return parsed
      .filter((c) => c.count >= minPixels)
      .map((c): ColorRegion => {
        const bounds = {
          x: desktop.x + c.minX / scaleX,
          y: desktop.y + c.minY / scaleY,
          width: (c.maxX - c.minX + step) / scaleX,
          height: (c.maxY - c.minY + step) / scaleY,
        };
        return {
          color: c.color,
          bounds,
          center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
          sampledPixels: c.count,
        };
      })
      .filter((r) => {
        const size = Math.max(r.bounds.width, r.bounds.height);
        return size >= (opts.minSize ?? 1) && size <= (opts.maxSize ?? Infinity);
      });
  }

  /** Repeatedly detect and click changing flat-color targets in one tool call. */
  async clickColorSequence(opts: ClickColorSequenceOptions): Promise<ClickColorSequenceResult> {
    const started = Date.now();
    const maxClicks = Math.max(1, Math.round(opts.maxClicks ?? 20));
    const timeoutMs = Math.max(1, Math.round(opts.timeoutMs ?? 30_000));
    const pollMs = Math.max(0, Math.round(opts.pollIntervalMs ?? 10));
    const targets: Array<ColorRegion & { elapsedMs: number }> = [];
    let previous = "";
    while (targets.length < maxClicks && Date.now() - started < timeoutMs) {
      const regions = await this.findColorRegions(opts);
      // Prefer compact regions; a duplicate color elsewhere tends to produce an
      // implausibly large aggregate bounding box and is filtered by maxSize.
      const target = regions.sort((a, b) => b.sampledPixels - a.sampledPixels)[0];
      const signature = target
        ? `${target.color}:${Math.round(target.center.x)}:${Math.round(target.center.y)}:${Math.round(target.bounds.width)}`
        : "";
      if (target && signature !== previous) {
        await this.moveMouse(target.center);
        await this.click("left");
        targets.push({ ...target, elapsedMs: Date.now() - started });
        previous = signature;
      } else if (pollMs) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    const elapsedMs = Date.now() - started;
    return {
      clicks: targets.length,
      elapsedMs,
      averageMs: targets.length ? elapsedMs / targets.length : null,
      timedOut: targets.length < maxClicks,
      targets,
    };
  }

  private async encode(
    result: Buffer,
    opts?: ScreenshotOptions
  ): Promise<Buffer> {
    const raw = result as unknown as RawScreenshot;
    // If a driver already returned an encoded image (e.g. CLI adapter), pass it
    // through. Only the raw-RGBA envelope needs encoding here.
    if (!raw || (raw as any).__raw !== true) {
      return result as Buffer;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    const format = opts?.format ?? this.opts.screenshotFormat ?? "jpeg";
    const scale = opts?.scale ?? this.opts.screenshotScale ?? 1;

    let pipeline = sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    });
    // Region crop (in captured-image pixel space). The native core currently
    // returns the full display, so we crop here via sharp. Clamp to bounds so
    // an out-of-range region doesn't throw.
    if (opts?.region) {
      const rx = Math.max(0, Math.min(Math.round(opts.region.x), raw.width - 1));
      const ry = Math.max(0, Math.min(Math.round(opts.region.y), raw.height - 1));
      const rw = Math.max(1, Math.min(Math.round(opts.region.width), raw.width - rx));
      const rh = Math.max(1, Math.min(Math.round(opts.region.height), raw.height - ry));
      pipeline = pipeline.extract({ left: rx, top: ry, width: rw, height: rh });
    }
    if (scale && scale !== 1) {
      const baseW = opts?.region ? Math.round(opts.region.width) : raw.width;
      pipeline = pipeline.resize(Math.round(baseW * scale));
    }
    if (format === "jpeg") {
      pipeline = pipeline.jpeg({ quality: 80 });
    } else {
      pipeline = pipeline.png();
    }
    return pipeline.toBuffer();
  }

  async screenshotBase64(opts?: ScreenshotOptions): Promise<string> {
    const buf = await this.screenshot(opts);
    return buf.toString("base64");
  }

  /**
   * Capture a screenshot with an optional labeled coordinate grid and/or a
   * crosshair marker drawn over it. Hugely helpful for an agent aiming clicks:
   * it can read approximate pixel coordinates straight off the image instead of
   * eyeballing against a raw frame. Grid coordinates are in the SCALED output
   * image's pixel space (i.e. what you actually see).
   */
  async screenshotAnnotated(
    opts?: ScreenshotOptions & {
      grid?: boolean;
      gridStep?: number;
      crosshair?: Point;
    }
  ): Promise<Buffer> {
    const base = await this.screenshot(opts);
    if (!opts?.grid && !opts?.crosshair) return base;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require("sharp");
    const meta = await sharp(base).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const step = Math.max(20, Math.round(opts.gridStep ?? Math.max(w, h) / 12));
    const parts: string[] = [];
    if (opts.grid) {
      for (let x = step; x < w; x += step) {
        parts.push(
          `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="rgba(255,0,80,0.35)" stroke-width="1"/>` +
            `<text x="${x + 2}" y="14" fill="rgba(255,0,80,0.9)" font-size="12" font-family="monospace">${x}</text>`
        );
      }
      for (let y = step; y < h; y += step) {
        parts.push(
          `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="rgba(255,0,80,0.35)" stroke-width="1"/>` +
            `<text x="2" y="${y - 2}" fill="rgba(255,0,80,0.9)" font-size="12" font-family="monospace">${y}</text>`
        );
      }
    }
    if (opts.crosshair) {
      const cx = Math.round(opts.crosshair.x);
      const cy = Math.round(opts.crosshair.y);
      parts.push(
        `<line x1="${cx}" y1="0" x2="${cx}" y2="${h}" stroke="rgba(0,180,255,0.9)" stroke-width="2"/>` +
          `<line x1="0" y1="${cy}" x2="${w}" y2="${cy}" stroke="rgba(0,180,255,0.9)" stroke-width="2"/>` +
          `<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="rgba(0,180,255,1)" stroke-width="2"/>` +
          `<text x="${cx + 8}" y="${cy - 8}" fill="rgba(0,180,255,1)" font-size="13" font-family="monospace">${cx},${cy}</text>`
      );
    }
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join(
      ""
    )}</svg>`;
    return sharp(base)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .toBuffer();
  }

  async pixelColor(p: Point): Promise<string> {
    return (await this.getDriver()).pixelColor(await this.clamp(p));
  }

  async mousePosition(): Promise<Point> {
    return (await this.getDriver()).mousePosition();
  }

  async moveMouse(p: Point, opts?: { duration?: number }): Promise<void> {
    return (await this.getDriver()).moveMouse(await this.clamp(p), opts);
  }

  async click(button: MouseButton = "left", opts?: { double?: boolean }): Promise<void> {
    return (await this.getDriver()).click(button, opts);
  }

  async drag(
    from: Point,
    to: Point,
    opts?: { button?: MouseButton; duration?: number }
  ): Promise<void> {
    const driver = await this.getDriver();
    return driver.drag(await this.clamp(from), await this.clamp(to), opts);
  }

  async scroll(dx: number, dy: number): Promise<void> {
    return (await this.getDriver()).scroll(dx, dy);
  }

  /**
   * Smooth, stepped scrolling: repeat a small scroll delta N times with a pause
   * between steps. This produces natural-looking motion (good for demos) and
   * lets the target UI keep up, instead of one giant jump.
   */
  async scrollBy(
    dx: number,
    dy: number,
    opts?: { repeat?: number; intervalMs?: number }
  ): Promise<void> {
    const repeat = Math.max(1, Math.round(opts?.repeat ?? 1));
    const intervalMs = Math.max(0, opts?.intervalMs ?? 0);
    const driver = await this.getDriver();
    for (let i = 0; i < repeat; i++) {
      await driver.scroll(dx, dy);
      if (intervalMs && i < repeat - 1) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  async typeText(text: string, opts?: { delay?: number }): Promise<void> {
    return (await this.getDriver()).typeText(text, opts);
  }

  async pressKey(key: string): Promise<void> {
    return (await this.getDriver()).pressKey(key);
  }

  async hotkey(...keys: string[]): Promise<void> {
    return (await this.getDriver()).hotkey(...keys);
  }

  async getActiveWindow(): Promise<{ title: string; bounds?: Region } | null> {
    const driver = await this.getDriver();
    if (driver.getActiveWindow) return driver.getActiveWindow();
    // macOS fallback via AppleScript.
    if (process.platform === "darwin") {
      const list = await this.listWindows();
      return list.length ? { title: list[0].title } : null;
    }
    return null;
  }

  async listWindows(): Promise<
    Array<{ title: string; app?: string; bounds?: Region }>
  > {
    const driver = await this.getDriver();
    if (driver.listWindows) return driver.listWindows();
    if (process.platform === "darwin") return this.listWindowsMac();
    return [];
  }

  private async listWindowsMac(): Promise<
    Array<{ title: string; app?: string; bounds?: Region }>
  > {
    // Enumerate visible windows of non-background apps via System Events.
    // Note: AppleScript uses the `tab` and `linefeed` constants for delimiters
    // (backslash escapes like \t / \n are NOT interpreted inside AS strings).
    const script = [
      'set output to ""',
      'tell application "System Events"',
      "  set procs to (every process whose background only is false)",
      "  repeat with p in procs",
      "    set appName to name of p",
      "    try",
      "      repeat with w in (windows of p)",
      "        set wName to name of w",
      "        set output to output & appName & tab & wName & linefeed",
      "      end repeat",
      "    end try",
      "  end repeat",
      "end tell",
      "return output",
    ].join("\n");
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], {
        maxBuffer: 1024 * 1024,
      });
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [app, ...rest] = l.split("\t");
          return { app: app?.trim(), title: rest.join(" ").trim() || app?.trim() };
        });
    } catch (e: any) {
      throw new Error(
        `Failed to list windows via osascript: ${e?.message || e}. ` +
          `Grant Accessibility permission to the host process (System Settings → Privacy & Security → Accessibility).`
      );
    }
  }

  async focusWindow(match: string): Promise<boolean> {
    const driver = await this.getDriver();
    if (driver.focusWindow) return driver.focusWindow(match);
    if (process.platform === "darwin") {
      // Best-effort: activate the app whose name matches.
      try {
        await execFileAsync("osascript", [
          "-e",
          `tell application "${match.replace(/"/g, '\\"')}" to activate`,
        ]);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async dispose(): Promise<void> {
    for (const d of this.drivers) {
      if (d.dispose) {
        try {
          await d.dispose();
        } catch {
          // ignore
        }
      }
    }
    this.active = null;
  }
}
