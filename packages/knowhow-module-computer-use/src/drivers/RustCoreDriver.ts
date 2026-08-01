import {
  ComputerDriver,
  DriverCapabilities,
  Display,
  MouseButton,
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

  async typeText(text: string): Promise<void> {
    this.ensureCore().typeText(text);
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
