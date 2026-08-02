/**
 * Shared, driver-agnostic interface for the computer-use service.
 *
 * The concrete implementation lives in `@tyvm/knowhow-module-computer-use`, but
 * we declare the shape here so that `ToolContext` / `ModuleContext` can carry a
 * `ComputerUse` service without the core knowhow package taking a runtime
 * dependency on the module.
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
  getActiveWindow?(): Promise<{ title: string; app?: string; bounds?: Region } | null>;
  listWindows?(): Promise<Array<{ title: string; app?: string; bounds?: Region }>>;
  focusWindow?(match: string): Promise<boolean>;

  accessibilityTrusted?(): Promise<boolean>;
  accessibilityElements?(options?: AccessibilityOptions): Promise<AccessibilityElement[]>;
  setAccessibilityValue?(id: string, value: string): Promise<void>;
  performAccessibilityAction?(id: string, action: string): Promise<void>;

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

  getActiveWindow(): Promise<{
    title: string;
    app?: string;
    bounds?: Region;
  } | null>;
  listWindows(): Promise<
    Array<{ title: string; app?: string; bounds?: Region }>
  >;
  focusWindow(match: string): Promise<boolean>;

  accessibilityTrusted(): Promise<boolean>;
  accessibilityElements(options?: AccessibilityOptions): Promise<AccessibilityElement[]>;
  setAccessibilityValue(id: string, value: string): Promise<void>;
  performAccessibilityAction(id: string, action: string): Promise<void>;

  dispose(): Promise<void>;
}
