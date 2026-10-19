/**
 * Wire types for the knowhow-computer-host IPC protocol.
 * Mirrors packages/knowhow-computer-host/PROTOCOL.md (newline-delimited JSON).
 */

export type HostRole = "control" | "worker";
export type SingleInstance = "replace" | "ignore" | "allow";
export type HostConcurrency = "drop" | "queue" | "parallel";

export interface HostStatus {
  version: string;
  pid: number;
  killSwitch: string;
  killSwitchArmed: boolean;
  hookError?: string;
  platform: string;
}

export interface WorkerInfo {
  id: string;
  name: string;
  pid: number;
  status: "running" | "paused" | "exited";
  exitCode?: number | null;
  startedAt: number;
  logPath: string;
  connected: boolean;
  hotkeysSuspended: boolean;
  hotkeyCount: number;
  trayStatus?: string;
}

/** Selector: any of name / id / all. */
export interface Selector {
  name?: string;
  id?: string;
  all?: boolean;
}

// ── control requests ──
export type ControlRequest =
  | { type: "status" }
  | { type: "list" }
  | {
      type: "start";
      name: string;
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      singleInstance?: SingleInstance;
    }
  | ({ type: "stop" } & Selector)
  | ({ type: "pause" } & Selector)
  | ({ type: "resume" } & Selector)
  | ({ type: "suspendHotkeys"; suspended?: boolean } & Selector)
  | { type: "restart"; name?: string; id?: string }
  | { type: "logs"; name?: string; id?: string; tail?: number }
  | { type: "shutdown" };

export interface ControlResults {
  status: HostStatus;
  list: { workers: WorkerInfo[] };
  start: { worker: WorkerInfo; started: boolean };
  stop: { stopped: string[] };
  pause: { workers: string[]; errors: string[] };
  resume: { workers: string[]; errors: string[] };
  suspendHotkeys: { workers: string[] };
  restart: { worker: WorkerInfo };
  logs: { path: string; tail: string };
  shutdown: { shuttingDown: boolean };
}

// ── hello ──
export interface HelloControl {
  type: "hello";
  role: "control";
}
export interface HelloWorker {
  type: "hello";
  role: "worker";
  workerId: string;
  name: string;
}
export type HelloMessage = HelloControl | HelloWorker;

// ── worker -> host ──
export interface RegisterHotkeyMsg {
  type: "registerHotkey";
  id: string;
  chord: string;
  anyModifiers?: boolean;
  consume?: boolean;
  noRepeat?: boolean;
  concurrency?: HostConcurrency;
}
export type WorkerMessage =
  | RegisterHotkeyMsg
  | { type: "unregisterHotkey"; id: string }
  | { type: "hotkeyDone"; id: string }
  | { type: "heldKeys"; keys: string[] }
  | { type: "trayStatus"; text: string }
  | { type: "trayMenuItem"; id: string; label: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  // native GUI (specs/E0-gui-protocol.md)
  | { type: "guiCreate"; windowId: string; spec: unknown; show?: boolean }
  | { type: "guiPatch"; windowId: string; patches: Array<{ id: string; props: Record<string, unknown> }> }
  | { type: "guiShow" | "guiHide" | "guiDestroy"; windowId: string }
  | { type: "guiFocus"; windowId: string; controlId?: string }
  | { type: "guiSetTitle"; windowId: string; title: string }
  | { type: "dialog"; kind: "alert" | "confirm" | "prompt"; title: string; message: string; default?: string }
  | { type: "tooltip"; text: string; ms: number; x: number | null; y: number | null };

// ── host -> worker events ──
export type HostEvent =
  | { type: "hotkey"; id: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "trayMenu"; id: string }
  | {
      type: "guiEvent";
      windowId: string;
      controlId: string | null;
      event: string;
      value?: string | number;
      selected?: number;
      checked?: boolean;
    };

export interface HostResponse<T = unknown> {
  reqId: unknown;
  ok: boolean;
  result?: T;
  error?: string;
}

/** Any message sent by the client (reqId optional, added by HostClient.request). */
export type ClientMessage = (HelloMessage | ControlRequest | WorkerMessage) & {
  reqId?: number;
};
