import type { HostClient } from "../host/HostClient";
import type {
  DialogRequest,
  DialogResult,
  GuiBackend,
  GuiHostEvent,
  GuiPatch,
  TooltipRequest,
  WindowSpec,
} from "./types";

/** A recorded operation (HeadlessGuiBackend.ops). */
export interface GuiOp {
  op: "create" | "patch" | "show" | "hide" | "focus" | "setTitle" | "destroy";
  windowId: string;
  [k: string]: unknown;
}

interface HeadlessWindow {
  spec: WindowSpec;
  title: string;
  shown: boolean;
  focused?: string;
  destroyed: boolean;
  onEvent: (ev: GuiHostEvent) => void;
}

/**
 * In-memory backend for runs without a host (and tests). It records every
 * operation and lets tests inject host events with `inject`.
 */
export class HeadlessGuiBackend implements GuiBackend {
  readonly ops: GuiOp[] = [];
  private windows = new Map<string, HeadlessWindow>();

  constructor(private log: (data: Record<string, unknown>) => void = () => {}) {}

  private record(op: GuiOp): void {
    this.ops.push(op);
    this.log({ gui: op.op, ...op });
  }

  async create(windowId: string, spec: WindowSpec, show: boolean, onEvent: (ev: GuiHostEvent) => void): Promise<void> {
    this.windows.set(windowId, { spec, title: spec.title, shown: show, destroyed: false, onEvent });
    this.record({ op: "create", windowId, title: spec.title, show });
  }
  patch(windowId: string, patches: GuiPatch[]): void {
    this.record({ op: "patch", windowId, patches });
  }
  show(windowId: string): void {
    const w = this.windows.get(windowId);
    if (w) w.shown = true;
    this.record({ op: "show", windowId });
  }
  hide(windowId: string): void {
    const w = this.windows.get(windowId);
    if (w) w.shown = false;
    this.record({ op: "hide", windowId });
  }
  focus(windowId: string, controlId?: string): void {
    const w = this.windows.get(windowId);
    if (w) w.focused = controlId;
    this.record({ op: "focus", windowId, controlId });
  }
  setTitle(windowId: string, title: string): void {
    const w = this.windows.get(windowId);
    if (w) w.title = title;
    this.record({ op: "setTitle", windowId, title });
  }
  destroy(windowId: string): void {
    const w = this.windows.get(windowId);
    if (w) {
      w.destroyed = true;
      w.shown = false;
    }
    this.record({ op: "destroy", windowId });
  }

  // ── test helpers ──

  /** Ids of windows that have been created (including destroyed ones). */
  windowIds(): string[] {
    return [...this.windows.keys()];
  }
  /** Id of the most recently created window. */
  lastWindowId(): string | undefined {
    return this.windowIds().pop();
  }
  /** Find a window id by exact title. */
  findByTitle(title: string): string | undefined {
    for (const [id, w] of this.windows) if (w.title === title || w.spec.title === title) return id;
    return undefined;
  }
  isShown(windowId: string): boolean {
    return !!this.windows.get(windowId)?.shown;
  }
  isDestroyed(windowId: string): boolean {
    return !!this.windows.get(windowId)?.destroyed;
  }
  opsOf(op: GuiOp["op"]): GuiOp[] {
    return this.ops.filter((o) => o.op === op);
  }
  /** Deliver a host event (as the host would) to the form. */
  inject(windowId: string, ev: Omit<GuiHostEvent, "type" | "windowId" | "controlId"> & { controlId?: string | null }): void {
    const w = this.windows.get(windowId);
    if (!w) throw new Error(`HeadlessGuiBackend.inject: no window "${windowId}"`);
    w.onEvent({ type: "guiEvent", windowId, controlId: null, ...ev } as GuiHostEvent);
  }
  /** Shorthand: inject a control event. */
  injectControl(windowId: string, controlId: string, event: string, extra: Partial<GuiHostEvent> = {}): void {
    this.inject(windowId, { ...extra, controlId, event });
  }
  /** Shorthand: the user clicked the window's close button. */
  injectClose(windowId: string): void {
    const w = this.windows.get(windowId);
    if (w) w.shown = false;
    this.inject(windowId, { controlId: null, event: "close" });
  }
}

/** Slim view of HostClient used by the backend (so tests can stub it). */
export type HostGuiClient = Pick<HostClient, "request" | "send" | "on" | "off">;

const FAR_FUTURE_MS = 2 ** 31 - 1;

/**
 * Backend speaking E0 wire messages over a worker's HostClient connection.
 * Dialogs/tooltips are requests (host replies with an error when unsupported,
 * in which case the caller falls back to the local implementation).
 */
export class HostGuiBackend implements GuiBackend {
  private routes = new Map<string, (ev: GuiHostEvent) => void>();
  private onEvent = (ev: any) => {
    if (ev?.type !== "guiEvent") return;
    this.routes.get(ev.windowId)?.(ev as GuiHostEvent);
  };

  constructor(private client: HostGuiClient) {
    client.on("event", this.onEvent);
  }

  async create(windowId: string, spec: WindowSpec, show: boolean, onEvent: (ev: GuiHostEvent) => void): Promise<void> {
    this.routes.set(windowId, onEvent);
    try {
      await this.client.request({ type: "guiCreate", windowId, spec, show } as any);
    } catch (e) {
      this.routes.delete(windowId);
      throw e;
    }
  }
  patch(windowId: string, patches: GuiPatch[]): void {
    this.client.send({ type: "guiPatch", windowId, patches } as any);
  }
  show(windowId: string): void {
    this.client.send({ type: "guiShow", windowId } as any);
  }
  hide(windowId: string): void {
    this.client.send({ type: "guiHide", windowId } as any);
  }
  focus(windowId: string, controlId?: string): void {
    this.client.send({ type: "guiFocus", windowId, ...(controlId ? { controlId } : {}) } as any);
  }
  setTitle(windowId: string, title: string): void {
    this.client.send({ type: "guiSetTitle", windowId, title } as any);
  }
  destroy(windowId: string): void {
    this.routes.delete(windowId);
    this.client.send({ type: "guiDestroy", windowId } as any);
  }

  async dialog(req: DialogRequest): Promise<DialogResult> {
    const res = await this.client.request(
      {
        type: "dialog",
        kind: req.kind,
        title: req.title,
        message: req.message,
        default: req.default ?? "",
      } as any,
      FAR_FUTURE_MS
    );
    return res as unknown as DialogResult;
  }

  async tooltip(req: TooltipRequest): Promise<void> {
    await this.client.request(
      { type: "tooltip", text: req.text, ms: req.ms, x: req.x, y: req.y } as any,
      5000
    );
  }

  dispose(): void {
    this.client.off("event", this.onEvent);
    this.routes.clear();
  }
}
