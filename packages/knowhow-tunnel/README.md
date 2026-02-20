# Knowhow Tunnel

HTTP tunnel implementation for proxying requests from a remote server to localhost services.

## Features

- **HTTP/HTTPS Proxying**: Stream HTTP requests to local services
- **WebSocket Support**: Proxy WebSocket connections (e.g., for HMR)
- **Streaming**: Zero-copy streaming with proper backpressure handling
- **Security**: Port allowlisting, concurrency limits, size limits
- **Observability**: Structured logging and metrics

## Installation

```bash
npm install @tyvm/knowhow-tunnel
```

## Usage

### Basic Example

```typescript
import WebSocket from "ws";
import { createTunnelHandler } from "@tyvm/knowhow-tunnel";

// Create WebSocket connection to server
const ws = new WebSocket("ws://server.com/tunnel");

// Create tunnel handler
const tunnel = createTunnelHandler(ws, {
  allowedPorts: [3000, 8080],
  maxConcurrentStreams: 50,
  logLevel: "info",
});

// Get stats
console.log(tunnel.getStats());
```

### Docker / Sandbox Mode

When running in Docker, use `host.docker.internal` to access host services:

```typescript
const tunnel = createTunnelHandler(ws, {
  allowedPorts: [3000],
  localHost: "host.docker.internal",
  logLevel: "info",
});
```

Or use port mapping if services run on different ports:

```typescript
const tunnel = createTunnelHandler(ws, {
  allowedPorts: [3000],
  portMapping: { 3000: 8080 }, // Remote 3000 -> Local 8080
  logLevel: "info",
});
```

### Configuration

```typescript
interface TunnelConfig {
  // Allowed ports for tunneling (empty = none allowed, safe default)
  allowedPorts?: number[];
  
  // Maximum concurrent streams
  maxConcurrentStreams?: number;
  
  // Maximum response size per stream (bytes)
  maxResponseSize?: number;
  
  // Connection timeout (ms)
  connectTimeout?: number;
  
  // Idle timeout (ms)
  idleTimeout?: number;
  
  // Force identity encoding (no compression)
  forceIdentityEncoding?: boolean;
  
  // Local host to proxy to
  localHost?: string;
  
  // Port mapping (remote port -> local port)
  // Useful for Docker or when services run on different ports
  portMapping?: {
    [remotePort: number]: number;
  };
  
  // Log level
  logLevel?: "debug" | "info" | "warn" | "error";
}
```

## Protocol

The tunnel uses JSON messages over WebSocket for control flow and streaming.

### Request Flow

1. **TUNNEL_REQUEST**: Server sends request metadata
   ```json
   {
     "type": "TUNNEL_REQUEST",
     "streamId": "uuid",
     "port": 3000,
     "method": "GET",
     "path": "/api/users",
     "headers": { ... },
     "scheme": "http"
   }
   ```

2. **TUNNEL_DATA**: Request body chunks (if any)
   ```json
   {
     "type": "TUNNEL_DATA",
     "streamId": "uuid",
     "data": "<base64>"
   }
   ```

3. **TUNNEL_END**: End of request body
   ```json
   {
     "type": "TUNNEL_END",
     "streamId": "uuid"
   }
   ```

### Response Flow

1. **TUNNEL_RESPONSE**: Agent sends response metadata
   ```json
   {
     "type": "TUNNEL_RESPONSE",
     "streamId": "uuid",
     "statusCode": 200,
     "headers": { ... }
   }
   ```

2. **TUNNEL_DATA**: Response body chunks
3. **TUNNEL_END**: End of response

### Error Handling

```json
{
  "type": "TUNNEL_ERROR",
  "streamId": "uuid",
  "error": "Connection refused",
  "statusCode": 502
}
```

### WebSocket Upgrade

For WebSocket connections (e.g., HMR):

```json
{
  "type": "TUNNEL_WS_UPGRADE",
  "streamId": "uuid",
  "port": 3000,
  "path": "/_next/webpack-hmr",
  "headers": { ... }
}
```

## Integration with Worker

See `src/worker.ts` for integration example.

## Architecture

```
Server (Remote)          WebSocket          Agent (Local)
     |                      |                      |
     |-- TUNNEL_REQUEST --->|                      |
     |                      |--- handleRequest --->| http.request()
     |                      |                      |    to localhost:port
     |<-- TUNNEL_RESPONSE --|                      |
     |<-- TUNNEL_DATA -------|<-- stream response -|
     |<-- TUNNEL_END --------|                     |
```

## Security Considerations

- Only tunnels to `127.0.0.1` by default
- Port allowlisting prevents unauthorized access
- Concurrency limits prevent resource exhaustion
- Size limits prevent memory issues
- Idle timeouts cleanup stale connections

## License

MIT
