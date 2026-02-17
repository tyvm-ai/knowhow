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
}

/**
 * Request metadata from server to agent
 */
export interface TunnelRequest {
  type: TunnelMessageType.REQUEST;
  streamId: string;
  workerId?: string; // Worker ID for URL rewriting
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

/**
 * Configuration for tunnel handler
 */
export interface TunnelConfig {
  /** Allowed ports for tunneling */
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
}

/**
 * Internal state for an active stream
 */
export interface StreamState {
  streamId: string;
  port: number;
  workerId?: string; // Worker ID for URL rewriting
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
