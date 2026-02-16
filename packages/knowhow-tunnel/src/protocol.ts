import {
  TunnelMessage,
  TunnelMessageType,
  TunnelRequest,
  TunnelResponse,
  TunnelData,
  TunnelEnd,
  TunnelError,
  TunnelWsUpgrade,
  TunnelWsData,
  TunnelWsClose,
} from "./types";

/**
 * Parse a tunnel message from JSON
 */
export function parseTunnelMessage(json: string): TunnelMessage {
  const obj = JSON.parse(json);
  
  // Validate required fields based on type
  if (!obj.type) {
    throw new Error("Missing 'type' field in tunnel message");
  }
  
  if (!obj.streamId) {
    throw new Error("Missing 'streamId' field in tunnel message");
  }
  
  switch (obj.type) {
    case TunnelMessageType.REQUEST:
      validateRequest(obj);
      break;
    case TunnelMessageType.RESPONSE:
      validateResponse(obj);
      break;
    case TunnelMessageType.DATA:
      validateData(obj);
      break;
    case TunnelMessageType.ERROR:
      validateError(obj);
      break;
    case TunnelMessageType.WS_UPGRADE:
      validateWsUpgrade(obj);
      break;
    case TunnelMessageType.WS_DATA:
      validateWsData(obj);
      break;
  }
  
  return obj as TunnelMessage;
}

function validateRequest(obj: any): void {
  if (!obj.port || typeof obj.port !== "number") {
    throw new Error("Invalid or missing 'port' field");
  }
  if (!obj.method || typeof obj.method !== "string") {
    throw new Error("Invalid or missing 'method' field");
  }
  if (!obj.path || typeof obj.path !== "string") {
    throw new Error("Invalid or missing 'path' field");
  }
  if (!obj.headers || typeof obj.headers !== "object") {
    throw new Error("Invalid or missing 'headers' field");
  }
}

function validateResponse(obj: any): void {
  if (typeof obj.statusCode !== "number") {
    throw new Error("Invalid or missing 'statusCode' field");
  }
  if (!obj.headers || typeof obj.headers !== "object") {
    throw new Error("Invalid or missing 'headers' field");
  }
}

function validateData(obj: any): void {
  if (!obj.data) {
    throw new Error("Missing 'data' field");
  }
}

function validateError(obj: any): void {
  if (!obj.error || typeof obj.error !== "string") {
    throw new Error("Invalid or missing 'error' field");
  }
}

function validateWsUpgrade(obj: any): void {
  if (!obj.port || typeof obj.port !== "number") {
    throw new Error("Invalid or missing 'port' field");
  }
  if (!obj.path || typeof obj.path !== "string") {
    throw new Error("Invalid or missing 'path' field");
  }
  if (!obj.headers || typeof obj.headers !== "object") {
    throw new Error("Invalid or missing 'headers' field");
  }
}

function validateWsData(obj: any): void {
  if (!obj.data) {
    throw new Error("Missing 'data' field");
  }
  if (typeof obj.isBinary !== "boolean") {
    throw new Error("Invalid or missing 'isBinary' field");
  }
}

/**
 * Serialize a tunnel message to JSON
 */
export function serializeTunnelMessage(message: TunnelMessage): string {
  // Handle Buffer data conversion for JSON
  if (message.type === TunnelMessageType.DATA && Buffer.isBuffer(message.data)) {
    return JSON.stringify({
      ...message,
      data: message.data.toString("base64"),
      _isBase64: true,
    });
  }
  
  if (message.type === TunnelMessageType.WS_DATA && Buffer.isBuffer(message.data)) {
    return JSON.stringify({
      ...message,
      data: message.data.toString("base64"),
      _isBase64: true,
    });
  }
  
  return JSON.stringify(message);
}

/**
 * Strip hop-by-hop headers that shouldn't be proxied
 */
export function stripHopByHopHeaders(
  headers: Record<string, string | string[]>
): Record<string, string | string[]> {
  const hopByHopHeaders = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
  ]);
  
  const result: Record<string, string | string[]> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Normalize headers for local request
 */
export function normalizeHeadersForLocal(
  headers: Record<string, string | string[]>,
  options: { forceIdentityEncoding?: boolean } = {}
): Record<string, string | string[]> {
  const normalized = stripHopByHopHeaders(headers);
  
  // Remove host header to avoid confusion
  delete normalized.host;
  delete normalized.Host;
  
  // Force identity encoding if configured
  if (options.forceIdentityEncoding) {
    normalized["accept-encoding"] = "identity";
  }
  
  return normalized;
}

/**
 * Check if a port is allowed
 */
export function isPortAllowed(port: number, allowedPorts?: number[]): boolean {
  if (!allowedPorts || allowedPorts.length === 0) {
    return true; // No restrictions
  }
  return allowedPorts.includes(port);
}
