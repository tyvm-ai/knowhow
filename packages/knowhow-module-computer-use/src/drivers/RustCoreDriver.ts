import {
  AccessibilityElement,
  AccessibilityOptions,
  ComputerDriver,
  DriverCapabilities,
  Display,
  MouseButton,
  OverlayPrimitive,
  Point,
  ScreenshotOptions,
  Size,
} from "@tyvm/knowhow";

/**
 * RustCoreDriver — the DEFAULT, knowhow-owned engine.
 *
 * A thin marshaller over `@tyvm/knowhow-computer-core` (our napi-rs addon). The
 * addon is lazy-required so that if a platform prebuild is missing the module
 * can still fall back to another registered driver instead of crashing on load.
 *
 * The native core returns RAW RGBA (RawImage) for screenshots; PNG/JPEG
 * encoding + scaling is applied one layer up in ComputerService (via sharp), so
 * this driver returns raw RGBA wrapped with its dimensions in a small envelope
 * that the service knows how to encode.
 */

// Envelope so ComputerService can encode raw RGBA without a second round-trip.
export interface RawScreenshot {
  __raw: true;
  width: number;
  height: number;
  data: Buffer;
}

function loadCore(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@tyvm/knowhow-computer-core");
  const Ctor = mod.ComputerCore || (mod.default && mod.default.ComputerCore);
  if (!Ctor) {
    throw new Error(
      "@tyvm/knowhow-computer-core did not export ComputerCore"
    );
  }
  return new Ctor();
}

export class RustCoreDriver implements ComputerDriver {
  readonly name = "rust-core";
  readonly priority = 100;

  private core: any | null = null;

  /** Attempt to load the native core; used by the service to test availability. */
  static tryLoad(): RustCoreDriver | null {
    try {
      const driver = new RustCoreDriver();
      driver.ensureCore();
      return driver;
    } catch {
      return null;
    }
  }

  private ensureCore(): any {
    if (!this.core) this.core = loadCore();
    return this.core;
  }

  async capabilities(): Promise<DriverCapabilities> {
    const c = this.ensureCore().capabilities();
    return {
      input: c.input,
      capture: c.capture,
      windows: c.windows,
      reason: c.reason,
    };
  }

  async getActiveWindow(): Promise<{
    title: string;
    app?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  } | null> {
    const core = this.ensureCore();
    if (typeof core.activeWindow !== "function") return null;
    const w = core.activeWindow();
    if (!w) return null;
    return {
      title: w.title || w.app || "",
      app: w.app,
      bounds: w.bounds
        ? {
            x: w.bounds.x,
            y: w.bounds.y,
            width: w.bounds.width,
            height: w.bounds.height,
          }
        : undefined,
    };
  }

  async listWindows(): Promise<
    Array<{
      title: string;
      app?: string;
      bounds?: { x: number; y: number; width: number; height: number };
    }>
  > {
    const core = this.ensureCore();
    if (typeof core.listWindows !== "function") return [];
    const list = core.listWindows() as Array<any>;
    return list.map((w) => ({
      title: w.title || w.app || "",
      app: w.app,
      bounds: w.bounds
        ? {
            x: w.bounds.x,
            y: w.bounds.y,
            width: w.bounds.width,
            height: w.bounds.height,
          }
        : undefined,
    }));
  }

  async accessibilityTrusted(): Promise<boolean> {
    const core = this.ensureCore();
    return typeof core.accessibilityTrusted === "function" && core.accessibilityTrusted();
  }

  async accessibilityElements(options?: AccessibilityOptions): Promise<AccessibilityElement[]> {
    const core = this.ensureCore();
    if (typeof core.accessibilityElements !== "function") {
      throw new Error("Native accessibility inspection is unavailable");
    }
    return core.accessibilityElements(options);
  }

  async setAccessibilityValue(id: string, value: string): Promise<void> {
    const core = this.ensureCore();
    if (typeof core.setAccessibilityValue !== "function")
      throw new Error("Native accessibility value setting is unavailable");
    core.setAccessibilityValue(id, value);
  }

  async performAccessibilityAction(id: string, action: string): Promise<void> {
    const core = this.ensureCore();
    if (typeof core.performAccessibilityAction !== "function")
      throw new Error("Native accessibility actions are unavailable");
    core.performAccessibilityAction(id, action);
  }

  async showOverlay(primitives: OverlayPrimitive[]): Promise<void> {
    const core = this.ensureCore();
    if (typeof core.showOverlay !== "function")
      throw new Error("Native debug overlays are unavailable");
    core.showOverlay(primitives);
  }

  async clearOverlay(): Promise<void> {
    const core = this.ensureCore();
    if (typeof core.clearOverlay !== "function")
      throw new Error("Native debug overlays are unavailable");
    core.clearOverlay();
  }

  async getDisplays(): Promise<Display[]> {
    return this.ensureCore().getDisplays().map((d: any) => ({
      id: d.id,
      bounds: { x: d.x, y: d.y, width: d.width, height: d.height },
      scaleFactor: d.scaleFactor,
      primary: d.primary,
    }));
  }

  async screenSize(): Promise<Size> {
    const s = this.ensureCore().screenSize();
    return { width: s.width, height: s.height };
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const raw = this.ensureCore().screenshot(
      opts
        ? {
            region: opts.region
              ? {
                  x: opts.region.x,
                  y: opts.region.y,
                  width: opts.region.width,
                  height: opts.region.height,
                }
              : undefined,
            displayId: opts.displayId,
            scale: opts.captureScale,
          }
        : undefined
    );
    // Return an envelope; ComputerService encodes RGBA -> png/jpeg via sharp.
    const envelope: RawScreenshot = {
      __raw: true,
      width: raw.width,
      height: raw.height,
      data: Buffer.from(raw.data),
    };
    return envelope as unknown as Buffer;
  }

  async pixelColor(p: Point): Promise<string> {
    // Delegate to the native core. Note: on Retina/HiDPI displays the native
    // pixelColor now scales the logical point by the display pixel ratio before
    // indexing the raw screenshot buffer (fixed in Rust). The screencapture is
    // done fresh per call — fast enough for occasional sampling.
    return this.ensureCore().pixelColor(p.x, p.y);
  }

  async mousePosition(): Promise<Point> {
    const p = this.ensureCore().mousePosition();
    return { x: p.x, y: p.y };
  }

  async moveMouse(p: Point): Promise<void> {
    this.ensureCore().moveMouse(p.x, p.y);
  }

  async click(button: MouseButton = "left", opts?: { double?: boolean }): Promise<void> {
    const core = this.ensureCore();
    core.click(button);
    if (opts?.double) core.click(button);
  }

  async mouseDown(button: MouseButton = "left"): Promise<void> {
    this.ensureCore().mouseButton(button, true);
  }

  async mouseUp(button: MouseButton = "left"): Promise<void> {
    this.ensureCore().mouseButton(button, false);
  }

  async drag(
    from: Point,
    to: Point,
    opts?: { button?: MouseButton }
  ): Promise<void> {
    const core = this.ensureCore();
    const button = opts?.button ?? "left";
    core.moveMouse(from.x, from.y);
    core.mouseButton(button, true);
    core.moveMouse(to.x, to.y);
    core.mouseButton(button, false);
  }

  async scroll(dx: number, dy: number): Promise<void> {
    this.ensureCore().scroll(dx, dy);
  }

  async typeText(text: string, opts?: { delay?: number }): Promise<void> {
    const delay = opts?.delay ?? 0;
    if (!Number.isFinite(delay) || delay < 0) {
      throw new Error("typeText delay must be a non-negative finite number");
    }
    const core = this.ensureCore();
    if (delay === 0) {
      core.typeText(text);
      return;
    }
    const characters = Array.from(text);
    for (let index = 0; index < characters.length; index++) {
      core.typeText(characters[index]);
      if (index + 1 < characters.length)
        await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  async pressKey(key: string): Promise<void> {
    this.ensureCore().pressKey(key);
  }

  async hotkey(...keys: string[]): Promise<void> {
    this.ensureCore().hotkey(keys);
  }

  async keyDown(key: string): Promise<void> {
    this.ensureCore().key(key, true);
  }

  async keyUp(key: string): Promise<void> {
    this.ensureCore().key(key, false);
  }
}
