/**
 * Shared, driver-agnostic contract for the computer-use service.
 *
 * Owned by this module (not knowhow core). The service is injected into the
 * shared context as `ComputerUse`; other modules that want typed access import
 * these types from `@tyvm/knowhow-module-computer-use` (type-only imports
 * don't create a runtime dependency).
 *
 * An adapter module (e.g. `@tyvm/knowhow-module-computer-use-nutjs`) can
 * register a `ComputerDriver` against the service in its `register` phase; the
 * base module then `init()`s and picks the best available driver.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Region extends Point, Size {}

export type MouseButton = "left" | "right" | "middle";

export interface OverlayPrimitive {
  kind: "rect" | "circle" | "line" | "point" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  x2?: number;
  y2?: number;
  text?: string;
  fontSize?: number;
  color?: string;
  lineWidth?: number;
}

/**
 * A top-level window as reported by a driver. `pid`/`exe`/`bundleId` are
 * optional: they are populated when the native core can resolve the owning
 * process (see computer-use AHK-style automations: `window.isActive({ exe })`).
 */
export interface WindowInfo {
  id?: number;
  title: string;
  app?: string;
  bounds?: Region;
  /** Owning process id. */
  pid?: number;
  /** Executable name or path of the owning process (e.g. `PathOfExile.exe`). */
  exe?: string;
  /** macOS bundle identifier of the owning application. */
  bundleId?: string;
}

/**
 * Thrown by optional driver methods when the underlying native build doesn't
 * implement them yet. Callers feature-detect by catching this and falling back.
 */
export class NativeUnsupportedError extends Error {
  readonly unsupported = true;
  constructor(feature: string) {
    super(`${feature} is not supported by this native core build`);
    this.name = "NativeUnsupportedError";
  }
}

export function isUnsupportedError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as any).unsupported === true;
}

export interface Display {
  id: number;
  bounds: Region;
  scaleFactor: number;
  primary: boolean;
}

export interface ScreenshotOptions {
  region?: Region;
  displayId?: number;
  format?: "png" | "jpeg";
  scale?: number;
  /** Native capture downscale. Unlike output encoding scale, drivers may apply
   * this before raw pixels cross the process boundary. */
  captureScale?: number;
}

export interface DriverCapabilities {
  input: boolean;
  capture: boolean;
  windows: boolean;
  reason?: string;
}

export interface AccessibilityElement {
  id: string;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  bounds?: Region;
  actions: string[];
  childCount: number;
}

export interface AccessibilityOptions {
  maxDepth?: number;
  maxElements?: number;
  interactiveOnly?: boolean;
}

/**
 * The engine seam. Concrete drivers (Rust core, CLI adapter, nut.js demo)
 * implement this. Registered with the service via `registerDriver`.
 */
export interface ComputerDriver {
  readonly name: string;
  /**
   * Lower numbers win when multiple drivers are registered. The default Rust
   * core registers at 100; a fallback CLI adapter at 500; an experimental demo
   * adapter can register at e.g. 10 to force selection.
   */
  readonly priority?: number;

  capabilities(): Promise<DriverCapabilities>;

  // screen
  getDisplays(): Promise<Display[]>;
  screenSize(): Promise<Size>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  pixelColor(p: Point): Promise<string>;

  // mouse
  mousePosition(): Promise<Point>;
  moveMouse(p: Point, opts?: { duration?: number }): Promise<void>;
  click(button?: MouseButton, opts?: { double?: boolean }): Promise<void>;
  mouseDown(button?: MouseButton): Promise<void>;
  mouseUp(button?: MouseButton): Promise<void>;
  drag(
    from: Point,
    to: Point,
    opts?: { button?: MouseButton; duration?: number }
  ): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;

  // keyboard
  typeText(text: string, opts?: { delay?: number }): Promise<void>;
  pressKey(key: string): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;

  // windows (optional / capability-gated)
  getActiveWindow?(): Promise<WindowInfo | null>;
  listWindows?(): Promise<WindowInfo[]>;
  focusWindow?(match: string): Promise<boolean>;

  // keyboard state / clipboard / sound (optional; feature-detected natively)
  /** Is `key` currently down? `physical` queries hardware state, not injected state. */
  keyState?(key: string, physical: boolean): Promise<boolean>;
  clipboardReadText?(): Promise<string>;
  clipboardWriteText?(text: string): Promise<void>;
  /** Monotonic counter that changes whenever the clipboard contents change. */
  clipboardChangeCount?(): Promise<number>;
  beep?(freq: number, ms: number): Promise<void>;

  accessibilityTrusted?(): Promise<boolean>;
  accessibilityElements?(options?: AccessibilityOptions): Promise<AccessibilityElement[]>;
  setAccessibilityValue?(id: string, value: string): Promise<void>;
  performAccessibilityAction?(id: string, action: string): Promise<void>;

  // click-through visual debugging (optional / platform capability-gated)
  showOverlay?(primitives: OverlayPrimitive[]): Promise<void>;
  clearOverlay?(): Promise<void>;

  dispose?(): Promise<void>;
}

/**
 * The registered service (`ComputerUse`) surfaced to tools/CLI/MCP. It owns
 * driver selection and provides the normalized, platform-agnostic verbs.
 *
 * We keep this as an interface (not a class) in the core package so the module
 * owns the concrete implementation; anything reading `context.ComputerUse`
 * codes against this contract.
 */
export interface ComputerUseService {
  /** Register a driver (called by the base module and any adapter modules). */
  registerDriver(driver: ComputerDriver): void;
  /** List the names of all registered drivers. */
  listDrivers(): string[];
  /** Resolve/select the active driver (highest priority + capable). */
  getDriver(): Promise<ComputerDriver>;

  capabilities(): Promise<DriverCapabilities>;
  getDisplays(): Promise<Display[]>;
  screenSize(): Promise<Size>;
  /** Returns encoded image bytes (PNG/JPEG) honoring service defaults. */
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  /** Convenience: base64 data (no data: prefix) for multimodal messages. */
  screenshotBase64(opts?: ScreenshotOptions): Promise<string>;
  pixelColor(p: Point): Promise<string>;

  mousePosition(): Promise<Point>;
  moveMouse(p: Point, opts?: { duration?: number }): Promise<void>;
  click(button?: MouseButton, opts?: { double?: boolean }): Promise<void>;
  drag(
    from: Point,
    to: Point,
    opts?: { button?: MouseButton; duration?: number }
  ): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  /** Smooth stepped scrolling (repeat a small delta with a pause between). */
  scrollBy?(
    dx: number,
    dy: number,
    opts?: { repeat?: number; intervalMs?: number }
  ): Promise<void>;

  typeText(text: string, opts?: { delay?: number }): Promise<void>;
  pressKey(key: string): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;

  /** Screenshot with an optional labeled grid and/or crosshair overlay. */
  screenshotAnnotated?(
    opts?: ScreenshotOptions & {
      grid?: boolean;
      gridStep?: number;
      crosshair?: Point;
    }
  ): Promise<Buffer>;

  getActiveWindow(): Promise<WindowInfo | null>;
  listWindows(): Promise<WindowInfo[]>;
  focusWindow(match: string): Promise<boolean>;

  accessibilityTrusted(): Promise<boolean>;
  accessibilityElements(options?: AccessibilityOptions): Promise<AccessibilityElement[]>;
  selectAccessibilityOption(id: string, option: string): Promise<void>;
  setAccessibilityValue(id: string, value: string): Promise<void>;
  performAccessibilityAction(id: string, action: string): Promise<void>;

  showOverlay(primitives: OverlayPrimitive[]): Promise<void>;
  clearOverlay(): Promise<void>;

  dispose(): Promise<void>;
}
