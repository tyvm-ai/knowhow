import { IncomingHttpHeaders } from "http";
import WebSocket from "ws";

/**
 * Message types for the tunnel protocol
 */
export enum TunnelMessageType {
  REQUEST = "TUNNEL_REQUEST",
  RESPONSE = "TUNNEL_RESPONSE",
  DATA = "TUNNEL_DATA",
  END = "TUNNEL_END",
  ERROR = "TUNNEL_ERROR",
  WS_UPGRADE = "TUNNEL_WS_UPGRADE",
  WS_DATA = "TUNNEL_WS_DATA",
  WS_CLOSE = "TUNNEL_WS_CLOSE",
  // PTY addon message types
  PTY_OPEN = "TUNNEL_PTY_OPEN",
  PTY_DATA = "TUNNEL_PTY_DATA",
  PTY_RESIZE = "TUNNEL_PTY_RESIZE",
  PTY_CLOSE = "TUNNEL_PTY_CLOSE",
  PTY_LIST = "TUNNEL_PTY_LIST",
  PTY_ATTACHED = "TUNNEL_PTY_ATTACHED",
  PTY_DETACH = "TUNNEL_PTY_DETACH",
  PTY_LIST_RESPONSE = "TUNNEL_PTY_LIST_RESPONSE",
  PTY_EXIT = "TUNNEL_PTY_EXIT",
  // Telemetry addon message types
  TELEMETRY_HELLO = "TUNNEL_TELEMETRY_HELLO",
  TELEMETRY_SAMPLE = "TUNNEL_TELEMETRY_SAMPLE",
  TELEMETRY_CONTROL = "TUNNEL_TELEMETRY_CONTROL",
}

/**
 * Request metadata from server to agent
 */
export interface TunnelRequest {
  type: TunnelMessageType.REQUEST;
  streamId: string;
  metadata?: any; // Additional metadata for URL rewriting
  port: number;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  scheme?: "http" | "https";
  deadlineMs?: number;
}

/**
 * Response metadata from agent to server
 */
export interface TunnelResponse {
  type: TunnelMessageType.RESPONSE;
  streamId: string;
  statusCode: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
}

/**
 * Data chunk for streaming body
 */
export interface TunnelData {
  type: TunnelMessageType.DATA;
  streamId: string;
  data: Buffer | string; // Buffer for binary, string for base64
}

/**
 * Stream end signal
 */
export interface TunnelEnd {
  type: TunnelMessageType.END;
  streamId: string;
}

/**
 * Error in stream
 */
export interface TunnelError {
  type: TunnelMessageType.ERROR;
  streamId: string;
  error: string;
  statusCode?: number;
}

/**
 * WebSocket upgrade request
 */
export interface TunnelWsUpgrade {
  type: TunnelMessageType.WS_UPGRADE;
  streamId: string;
  port: number;
  path: string;
  headers: Record<string, string | string[]>;
}

/**
 * WebSocket data frame
 */
export interface TunnelWsData {
  type: TunnelMessageType.WS_DATA;
  streamId: string;
  data: Buffer | string;
  isBinary: boolean;
}

/**
 * WebSocket close
 */
export interface TunnelWsClose {
  type: TunnelMessageType.WS_CLOSE;
  streamId: string;
  code?: number;
  reason?: string;
}

/**
 * Union type for all tunnel messages
 */
export type TunnelMessage =
  | TunnelRequest
  | TunnelResponse
  | TunnelData
  | TunnelEnd
  | TunnelError
  | TunnelWsUpgrade
  | TunnelWsData
  | TunnelWsClose;

export type UrlRewriterCallback = (port: number, metadata?: any) => string;

/**
 * Configuration for tunnel handler
 */
export interface TunnelConfig {
  /** Allowed ports for tunneling. Empty array or undefined = no ports allowed (safe default) */
  allowedPorts?: number[];
  /** Maximum concurrent streams */
  maxConcurrentStreams?: number;
  /** Maximum response size per stream in bytes */
  maxResponseSize?: number;
  /** Connect timeout in milliseconds */
  connectTimeout?: number;
  /** Idle timeout in milliseconds */
  idleTimeout?: number;
  /** Whether to force identity encoding (no compression) */
  forceIdentityEncoding?: boolean;
  /** Local host to proxy to */
  localHost?: string;
  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error";
  portMapping?: {
    [remotePort: number]: number; // remotePort -> localPort
  };
  /** Worker ID for URL rewriting */
  workerId?: string;
  /** Enable URL rewriting of localhost URLs */
  enableUrlRewriting?: boolean;
  /** Tunnel domain for URL rewriting (e.g., "knowhow.tyvm.ai" or "localhost:4000") */
  tunnelDomain?: string;
  /** Whether the tunnel domain uses HTTPS (for URL rewriting) */
  tunnelUseHttps?: boolean;
  /** URL rewriter callback function for custom URL replacement logic */
  urlRewriter?: UrlRewriterCallback;
}

/**
 * Internal state for an active stream
 */
export interface StreamState {
  streamId: string;
  port: number;
  workerId?: string; // Worker ID for URL rewriting
  metadata?: any; // Additional metadata for URL rewriting
  method: string;
  path: string;
  startTime: number;
  bytesReceived: number;
  bytesSent: number;
  request?: any; // http.ClientRequest
  response?: any; // http.IncomingMessage
  wsClient?: WebSocket; // For WebSocket upgrades
  isPaused: boolean;
  deadlineTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

// ─── PTY Message Types ────────────────────────────────────────────────────────

/**
 * Backend → Worker: open a PTY session
 */
export interface TunnelPtyOpen {
  type: TunnelMessageType.PTY_OPEN;
  streamId: string;
  /** Stable PTY identity. Unlike streamId, this survives browser reconnects. */
  terminalId?: string;
  command: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/**
 * Bidirectional: PTY output (worker → backend) or keyboard input (backend → worker)
 */
export interface TunnelPtyData {
  type: TunnelMessageType.PTY_DATA;
  streamId: string;
  data: string; // base64 encoded
}

/**
 * Backend → Worker: resize the PTY window
 */
export interface TunnelPtyResize {
  type: TunnelMessageType.PTY_RESIZE;
  streamId: string;
  cols: number;
  rows: number;
}

/**
 * Backend → Worker: close the PTY session
 */
export interface TunnelPtyClose {
  type: TunnelMessageType.PTY_CLOSE;
  streamId: string;
  terminalId?: string;
}

export interface TunnelPtyList {
  type: TunnelMessageType.PTY_LIST;
  streamId: string;
}

export interface TunnelPtySessionInfo {
  terminalId: string;
  pid: number;
  command: string;
  createdAt: string;
  cols: number;
  rows: number;
}

export interface TunnelPtyAttached {
  type: TunnelMessageType.PTY_ATTACHED;
  streamId: string;
  terminalId: string;
  existing: boolean;
}

export interface TunnelPtyDetach {
  type: TunnelMessageType.PTY_DETACH;
  streamId: string;
}

export interface TunnelPtyListResponse {
  type: TunnelMessageType.PTY_LIST_RESPONSE;
  streamId: string;
  sessions: TunnelPtySessionInfo[];
}

/**
 * Worker → Backend: PTY process exited
 */
export interface TunnelPtyExit {
  type: TunnelMessageType.PTY_EXIT;
  streamId: string;
  exitCode: number;
}

export type TunnelPtyMessage =
  | TunnelPtyOpen
  | TunnelPtyData
  | TunnelPtyResize
  | TunnelPtyClose
  | TunnelPtyList
  | TunnelPtyAttached
  | TunnelPtyDetach
  | TunnelPtyListResponse
  | TunnelPtyExit;

// ─── Telemetry Message Types ──────────────────────────────────────────────────

/**
 * Worker → Backend: initial telemetry handshake announcing capabilities.
 */
export interface TunnelTelemetryHello {
  type: TunnelMessageType.TELEMETRY_HELLO;
  version: 1;
  bootId: string;
  capabilities: string[];
}

/**
 * Backend → Worker: accept/reject negotiation + session parameters.
 */
export interface TunnelTelemetryControl {
  type: TunnelMessageType.TELEMETRY_CONTROL;
  version: 1;
  accepted: boolean;
  sessionId?: string;
  intervalMs?: number;
  maxPayloadBytes?: number;
  reason?: string;
}

/**
 * Worker → Backend: periodic telemetry sample.
 */
export interface TunnelTelemetrySample {
  type: TunnelMessageType.TELEMETRY_SAMPLE;
  version: 1;
  bootId: string;
  sessionId: string;
  sequence: number;
  observedAt: string;
  uptimeMs: number;
  capabilities?: string[];
  runtime?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  collectorError?: boolean;
}

export type TunnelTelemetryMessage =
  | TunnelTelemetryHello
  | TunnelTelemetryControl
  | TunnelTelemetrySample;

// ─── Addon Interface ──────────────────────────────────────────────────────────

/**
 * Context passed to addon message handlers
 */
export interface TunnelAddonContext {
  /** Send a message back over the tunnel WebSocket */
  send(
    message: TunnelMessage | TunnelPtyMessage | TunnelTelemetryMessage
  ): void;
  /** Bytes queued by the underlying WebSocket, for addon backpressure. */
  readonly bufferedAmount?: number;
}

/**
 * TunnelAddon — pluggable handler for tunnel messages.
 *
 * Addons register the message types they handle via `handles`.
 * Each entry can be an exact type string ("TUNNEL_REQUEST") or
 * a prefix ending with "_" ("TUNNEL_PTY_") that matches all PTY types.
 */
export interface TunnelAddon {
  name: string;
  /**
   * List of exact type strings OR prefix strings ending with "_".
   * e.g. ["TUNNEL_PTY_"] matches PTY_OPEN, PTY_DATA, PTY_RESIZE, etc.
   */
  handles: string[];
  onConnect?(ctx: TunnelAddonContext): void;
  onMessage(
    message: TunnelMessage | TunnelPtyMessage | TunnelTelemetryMessage,
    ctx: TunnelAddonContext
  ): void | Promise<void>;
  onDisconnect?(ctx: TunnelAddonContext): void;
}

// Extend the union type to include PTY messages
export type AnyTunnelMessage =
  | TunnelMessage
  | TunnelPtyMessage
  | TunnelTelemetryMessage;
