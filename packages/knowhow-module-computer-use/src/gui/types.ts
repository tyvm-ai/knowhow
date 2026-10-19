/**
 * Native GUI form types (contract: specs/E0-gui-protocol.md).
 * The spec is plain JSON, sent once to the host in `guiCreate`.
 */

export type Align = "start" | "center" | "end" | "stretch";

export interface CommonProps {
  id?: string;
  grow?: number;
  width?: number;
  height?: number;
  align?: Align;
  enabled?: boolean;
  visible?: boolean;
}

export type RowNode = CommonProps & { type: "row" | "column"; children: Node[]; gap?: number; padding?: number };
export type GridNode = CommonProps & {
  type: "grid";
  columns: number;
  children: Array<Node & { colSpan?: number }>;
  gap?: number;
};
export type GroupNode = CommonProps & { type: "group"; title?: string; children: Node[] };
export type SpacerNode = CommonProps & { type: "spacer" };
export type SeparatorNode = CommonProps & { type: "separator" };
export type LabelNode = CommonProps & { type: "label"; text: string };
export type InputNode = CommonProps & {
  type: "input";
  label?: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
};
export type TextareaNode = CommonProps & {
  type: "textarea";
  label?: string;
  value?: string;
  readOnly?: boolean;
  wrap?: boolean;
  monospace?: boolean;
};
export type NumberNode = CommonProps & {
  type: "number";
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
};
export type CheckboxNode = CommonProps & { type: "checkbox"; text: string; checked?: boolean };
export type DropdownNode = CommonProps & { type: "dropdown"; label?: string; options: string[]; selected?: number };
export type ListboxNode = CommonProps & { type: "listbox"; label?: string; items: string[]; selected?: number };
export type ButtonNode = CommonProps & { type: "button"; text: string; default?: boolean };
export type ProgressNode = CommonProps & { type: "progress"; value?: number; max?: number };

export type Node =
  | RowNode
  | GridNode
  | GroupNode
  | SpacerNode
  | SeparatorNode
  | LabelNode
  | InputNode
  | TextareaNode
  | NumberNode
  | CheckboxNode
  | DropdownNode
  | ListboxNode
  | ButtonNode
  | ProgressNode;

export type NodeType = Node["type"];
export type CloseBehavior = "hide" | "exit" | "destroy";

export interface WindowSpec {
  title: string;
  /** Logical points (content size). Default 480x360. */
  width?: number;
  height?: number;
  resizable?: boolean;
  alwaysOnTop?: boolean;
  /** hide (default): nothing more; destroy: destroy the form; exit: stop the automation. */
  closeBehavior?: CloseBehavior;
  position?: "center" | "cursor" | { x: number; y: number };
  layout: Node;
}

/** Props that may be patched with `form.set(id, props)`. */
export interface PatchProps {
  text?: string;
  value?: string | number;
  options?: string[];
  items?: string[];
  selected?: number;
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  max?: number;
}

/** Snapshot returned by `form.get(id)` (from the local mirror). */
export interface ControlState extends PatchProps {}

export type ControlEventName = "click" | "change" | "select" | "submit";
export type WindowEventName = "close" | "show" | "hide";

export interface GuiEvent {
  /** Control id; "" for window-level events. */
  id: string;
  event: ControlEventName | WindowEventName;
  value?: string | number;
  selected?: number;
  checked?: boolean;
}

export type GuiHandler = (ev: GuiEvent) => void | Promise<void>;

export interface GuiPatch {
  id: string;
  props: PatchProps;
}

/** Host -> worker event (wire shape, E0). */
export interface GuiHostEvent {
  type?: "guiEvent";
  windowId?: string;
  controlId: string | null;
  event: string;
  value?: string | number;
  selected?: number;
  checked?: boolean;
}

export interface DialogRequest {
  kind: "alert" | "confirm" | "prompt";
  title: string;
  message: string;
  default?: string;
}
export interface DialogResult {
  button: "ok" | "cancel" | "yes" | "no";
  value?: string;
}
export interface TooltipRequest {
  text: string;
  ms: number;
  x: number | null;
  y: number | null;
}

/**
 * Transport for native forms. Two implementations: HostGuiBackend (knowhow
 * computer host over IPC) and HeadlessGuiBackend (in-memory).
 */
export interface GuiBackend {
  create(
    windowId: string,
    spec: WindowSpec,
    show: boolean,
    onEvent: (ev: GuiHostEvent) => void
  ): Promise<void>;
  patch(windowId: string, patches: GuiPatch[]): void;
  show(windowId: string): void;
  hide(windowId: string): void;
  focus(windowId: string, controlId?: string): void;
  setTitle(windowId: string, title: string): void;
  destroy(windowId: string): void;
  /** Native dialog; absent on backends without UI (callers fall back). Rejects on error. */
  dialog?(req: DialogRequest): Promise<DialogResult>;
  /** Native tooltip; absent on backends without UI. Rejects on error. */
  tooltip?(req: TooltipRequest): Promise<void>;
  dispose?(): void;
}
