/**
 * Core types of the StatefulProcess primitive.
 * See .knowhow/tasks/stateful-processes/design.md
 */

export type Unsubscribe = () => void;

export type ProcessStatus =
  | "created"
  | "running"
  | "paused"
  | "waiting" // blocked on input/timer
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: readonly ProcessStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminalStatus(s: ProcessStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export interface Lifecycle {
  status: ProcessStatus;
  startedAt?: string;
  updatedAt: string;
  endedAt?: string;
  result?: unknown;
  error?: { message: string; stack?: string; code?: string };
  resumable: "none" | "restart" | "checkpoint" | "replay";
  executor?: { host: string; pid: number; heartbeatAt: string };
}

export interface BaseControl {
  desired?: "running" | "paused" | "cancelled";
  interrupt?: { id: string; message?: string };
}

export interface ProcessMeta {
  id: string;
  kind: string;
  name?: string;
  parentId?: string;
  createdAt: string;
  schemaVersion: number;
  links?: Record<string, string>;
}

/**
 * A stream item delivered by an input channel. Edge-triggered: each item must
 * be handled exactly once (acknowledged via `consume()`).
 */
export interface InputItem {
  id: string;
  kind: string;
  payload: unknown;
  at: string;
  from?: string;
  /** id of the channel that delivered it */
  source: string;
}

/** Per input channel id; opaque to the process (byte offset+inode, row id, ...). */
export type InputCursors = Record<string, unknown>;

export interface ProcessDocument<S = any, C extends BaseControl = BaseControl> {
  meta: ProcessMeta;
  /** written ONLY by the owner process */
  state: S;
  /** written ONLY from outside via applyControl */
  control: C;
  /** written ONLY by the owner process */
  lifecycle: Lifecycle;
  /** owner's state version, +1 per committed update */
  version: number;
  controlVersion: number;
  /** owner: "I have applied control up to here" */
  observedControlVersion: number;
}

export interface StateChange<S, E = never> {
  version: number;
  prev: S;
  next: S;
  events: E[];
  reason?: string;
}

export interface ControlChange<C> {
  controlVersion: number;
  prev: C;
  next: C;
  source: string;
}

export interface InputCursor {
  source: string;
  value: unknown;
}

/** Surface implemented by StatefulProcess AND ProcessMirror. */
export interface ProcessHandle<S = any, C extends BaseControl = BaseControl, E = any> {
  readonly meta: ProcessMeta;
  getState(): Readonly<S>;
  getControl(): Readonly<C>;
  getLifecycle(): Readonly<Lifecycle>;
  onStateUpdated(cb: (c: StateChange<S, E>) => void): Unsubscribe;
  changes(signal?: AbortSignal): AsyncIterable<StateChange<S, E>>;
  applyControl(patch: Partial<C> | ((c: C) => C), source?: string): void | Promise<void>;
  send(kind: string, payload: unknown, opts?: { id?: string; from?: string }): unknown;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  cancel(): void | Promise<void>;
  interrupt(message?: string): void | Promise<void>;
}

export class ProcessCancelledError extends Error {
  constructor(message = "process cancelled") {
    super(message);
    this.name = "ProcessCancelledError";
  }
}
