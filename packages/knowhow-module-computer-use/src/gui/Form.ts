import type {
  ControlEventName,
  ControlState,
  GuiBackend,
  GuiEvent,
  GuiHandler,
  GuiHostEvent,
  GuiPatch,
  Node,
  NodeType,
  PatchProps,
  WindowEventName,
  WindowSpec,
} from "./types";
import { CONTAINER_TYPES, suggest, validatePatch, validateSpec } from "./validate";

const CONTROL_EVENTS: ControlEventName[] = ["click", "change", "select", "submit"];
const WINDOW_EVENTS: WindowEventName[] = ["close", "show", "hide"];

export interface FormHooks {
  /** Telemetry/log sink (runner emit). */
  log: (data: Record<string, unknown>) => void;
  /** closeBehavior "exit": stop the automation. */
  onExit?: () => void;
  /** Called exactly once when the form is destroyed (release lifetime etc.). */
  onDestroyed?: (form: Form) => void;
}

interface Entry {
  type: NodeType;
  state: Record<string, any>;
}

function initialState(n: any): Record<string, any> {
  const st: Record<string, any> = {};
  switch (n.type as NodeType) {
    case "label":
    case "button":
    case "checkbox":
      st.text = n.text ?? "";
      if (n.type === "checkbox") st.checked = !!n.checked;
      break;
    case "group":
      st.text = n.title ?? "";
      break;
    case "input":
    case "textarea":
      st.value = n.value ?? "";
      break;
    case "number":
      st.value = n.value ?? n.min ?? 0;
      break;
    case "dropdown":
      st.options = [...(n.options ?? [])];
      st.selected = n.selected ?? -1;
      break;
    case "listbox":
      st.items = [...(n.items ?? [])];
      st.selected = n.selected ?? -1;
      break;
    case "progress":
      st.value = n.value ?? 0;
      st.max = n.max ?? 100;
      break;
  }
  st.enabled = n.enabled ?? true;
  st.visible = n.visible ?? true;
  return st;
}

/**
 * A native form: a synchronous local mirror of every identified control, event
 * dispatch, and per-tick patch batching to a GuiBackend.
 */
export class Form {
  /** True while the window is shown (created hidden). */
  visible = false;
  destroyed = false;

  private entries = new Map<string, Entry>();
  private handlers = new Map<string, Set<GuiHandler>>();
  private pending = new Map<string, PatchProps>();
  private flushScheduled = false;
  private spec: WindowSpec;

  constructor(
    readonly windowId: string,
    spec: WindowSpec,
    private backend: GuiBackend,
    private hooks: FormHooks
  ) {
    validateSpec(spec);
    this.spec = spec;
    this.index(spec.layout);
  }

  /** Validate, register with the backend (hidden), and return the form. */
  static async create(
    windowId: string,
    spec: WindowSpec,
    backend: GuiBackend,
    hooks: FormHooks
  ): Promise<Form> {
    const form = new Form(windowId, spec, backend, hooks);
    await backend.create(windowId, spec, false, (ev) => form.dispatch(ev));
    return form;
  }

  private index(node: Node): void {
    if (node.id) this.entries.set(node.id, { type: node.type, state: initialState(node) });
    if (CONTAINER_TYPES.includes(node.type)) {
      for (const c of (node as any).children as Node[]) this.index(c);
    }
  }

  private entry(id: string, who: string): Entry {
    const e = this.entries.get(id);
    if (!e) {
      throw new Error(
        `form.${who}("${id}"): no control with that id.${suggest(id, [...this.entries.keys()])} ` +
          `Known ids: ${[...this.entries.keys()].join(", ") || "(none)"}.`
      );
    }
    return e;
  }

  /** Ids of all identified controls. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  // ── state mirror ──

  /** Synchronous read of a control's current state (mirror, includes pending sets). */
  get(id: string): ControlState {
    const e = this.entry(id, "get");
    const out: Record<string, any> = { ...e.state };
    if (Array.isArray(out.options)) out.options = [...out.options];
    if (Array.isArray(out.items)) out.items = [...out.items];
    return out;
  }

  /**
   * Patch a control. The mirror updates immediately; the IPC message is batched
   * with other sets in the same tick into one guiPatch. Programmatic sets never
   * produce change/select events.
   */
  set(id: string, props: PatchProps): void {
    const e = this.entry(id, "set");
    validatePatch(id, e.type, props);
    if (this.destroyed) return;
    const p: Record<string, any> = { ...(props as any) };
    if (p.options) p.options = [...p.options];
    if (p.items) p.items = [...p.items];
    Object.assign(e.state, p);
    // Replacing the list invalidates a now out-of-range selection (host clamps too).
    const list = p.options ?? p.items;
    if (list && p.selected === undefined && typeof e.state.selected === "number" && e.state.selected >= list.length) {
      e.state.selected = -1;
      p.selected = -1;
    }
    const prev = this.pending.get(id);
    this.pending.set(id, prev ? { ...prev, ...p } : p);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Send pending patches now (called automatically per microtask and before other ops). */
  flush(): void {
    this.flushScheduled = false;
    if (!this.pending.size) return;
    const patches: GuiPatch[] = [...this.pending].map(([id, props]) => ({ id, props }));
    this.pending.clear();
    if (this.destroyed) return;
    try {
      this.backend.patch(this.windowId, patches);
    } catch (e: any) {
      this.hooks.log({ guiError: "patch", windowId: this.windowId, error: e?.message ?? String(e) });
    }
  }

  // ── window ops ──

  show(): void {
    if (this.destroyed) return;
    this.flush();
    const was = this.visible;
    this.visible = true;
    this.backend.show(this.windowId);
    if (!was) this.emitWindow("show");
  }

  hide(): void {
    if (this.destroyed) return;
    this.flush();
    const was = this.visible;
    this.visible = false;
    this.backend.hide(this.windowId);
    if (was) this.emitWindow("hide");
  }

  focus(controlId?: string): void {
    if (this.destroyed) return;
    if (controlId !== undefined) this.entry(controlId, "focus");
    this.flush();
    this.backend.focus(this.windowId, controlId);
  }

  setTitle(title: string): void {
    if (this.destroyed) return;
    this.flush();
    this.spec = { ...this.spec, title };
    this.backend.setTitle(this.windowId, String(title));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.flush();
    this.destroyed = true;
    this.visible = false;
    try {
      this.backend.destroy(this.windowId);
    } catch (e: any) {
      this.hooks.log({ guiError: "destroy", windowId: this.windowId, error: e?.message ?? String(e) });
    }
    this.hooks.onDestroyed?.(this);
  }

  // ── events ──

  /**
   * Control handler: `form.on("saveBtn", "click", fn)`.
   * Window handler:  `form.on("close" | "show" | "hide", fn)`.
   * Returns an unsubscribe function.
   */
  on(event: WindowEventName, fn: GuiHandler): () => void;
  on(id: string, event: ControlEventName, fn: GuiHandler): () => void;
  on(a: string, b: any, c?: any): () => void {
    let key: string;
    let fn: GuiHandler;
    if (typeof b === "function") {
      if (!WINDOW_EVENTS.includes(a as WindowEventName)) {
        throw new Error(
          `form.on("${a}", fn): window events are ${WINDOW_EVENTS.join(", ")}. ` +
            `For a control use form.on(id, "click"|"change"|"select"|"submit", fn).`
        );
      }
      key = `:${a}`;
      fn = b;
    } else {
      this.entry(a, "on");
      if (!CONTROL_EVENTS.includes(b)) {
        throw new Error(
          `form.on("${a}", "${b}", fn): unknown event "${b}".${suggest(String(b), CONTROL_EVENTS)} ` +
            `Events: ${CONTROL_EVENTS.join(", ")}.`
        );
      }
      if (typeof c !== "function") throw new Error(`form.on("${a}", "${b}", fn) requires a function.`);
      key = `${a}:${b}`;
      fn = c;
    }
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  /** Handle a host event: update the mirror FIRST, then run handlers. */
  dispatch(raw: GuiHostEvent): void {
    if (this.destroyed) return;
    if (raw.controlId === null || raw.controlId === undefined) {
      if (raw.event === "close") this.onClose();
      return;
    }
    const entry = this.entries.get(raw.controlId);
    if (!entry) {
      this.hooks.log({ guiEvent: "unknown-control", windowId: this.windowId, controlId: raw.controlId });
      return;
    }
    const ev: GuiEvent = { id: raw.controlId, event: raw.event as ControlEventName };
    if (raw.value !== undefined) ev.value = raw.value;
    if (raw.selected !== undefined) ev.selected = raw.selected;
    if (raw.checked !== undefined) ev.checked = raw.checked;
    if (raw.event === "change" || raw.event === "select" || raw.event === "submit") {
      if (raw.value !== undefined) entry.state.value = raw.value;
      if (raw.checked !== undefined) entry.state.checked = raw.checked;
      if (raw.selected !== undefined) entry.state.selected = raw.selected;
    }
    this.run(`${raw.controlId}:${raw.event}`, ev, `${raw.controlId}.${raw.event}`);
  }

  private onClose(): void {
    // The host hides the window itself; mirror that, then apply closeBehavior.
    this.visible = false;
    this.run(":close", { id: "", event: "close" }, "close");
    const behavior = this.spec.closeBehavior ?? "hide";
    if (behavior === "destroy") this.destroy();
    else if (behavior === "exit") this.hooks.onExit?.();
  }

  private emitWindow(event: "show" | "hide"): void {
    this.run(`:${event}`, { id: "", event }, event);
  }

  private run(key: string, ev: GuiEvent, label: string): void {
    const set = this.handlers.get(key);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        const r = fn(ev);
        if (r && typeof (r as any).then === "function") {
          (r as Promise<void>).catch((e: any) => this.logHandlerError(label, e));
        }
      } catch (e: any) {
        this.logHandlerError(label, e);
      }
    }
  }

  private logHandlerError(label: string, e: any): void {
    this.hooks.log({ guiHandlerError: label, windowId: this.windowId, error: e?.message ?? String(e) });
  }
}
