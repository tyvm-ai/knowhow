# Knowhow Tunnel Integration Guide

## Overview

The knowhow tunnel allows remote servers to proxy HTTP/WebSocket requests to localhost services running on worker machines. This is useful for:
- Accessing dev servers (Next.js, React, Vue, etc.) running on a remote worker
- Testing webhooks that need to hit localhost
- Proxying API requests to local services

## Configuration

Add tunnel configuration to your `.knowhow/knowhow.json`:

```json
{
  "worker": {
    "allowedTools": ["readFile", "writeFile", ...],
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 8080, 5173],
      "maxConcurrentStreams": 50
      "portMapping": {
        "3000": 3001
      }
    }
  }
}
```

### Configuration Options

- **`enabled`** (boolean): Enable/disable the tunnel. Default: `false`
- **`allowedPorts`** (number[]): List of ports that can be tunneled. Empty array = no access
- **`maxConcurrentStreams`** (number): Maximum concurrent HTTP requests. Default: `50`
- **`portMapping`** (object): Map remote ports to different local ports. Useful for Docker.
- **`localHost`** (string): Host to connect to. Default: `"127.0.0.1"`, or `"host.docker.internal"` in Docker.

## Security Considerations

### Port Allowlisting
Only ports explicitly listed in `allowedPorts` can be accessed. This prevents unauthorized access to sensitive services.

**Example:**
```json
{
  "tunnel": {
    "enabled": true,
    "allowedPorts": [3000]  // Only Next.js dev server accessible
  }
}
```

### Local Only
The tunnel only proxies to `127.0.0.1` (localhost). It cannot access:
- Other machines on your network
- Services bound to `0.0.0.0` but not accepting localhost connections
- Docker containers (unless they expose ports to localhost)

### Resource Limits
- **Concurrent streams**: Prevents too many simultaneous requests
- **Max response size**: Default 100MB per request
- **Idle timeout**: Closes stale connections (default 60s)
- **Connect timeout**: Fails if connection takes too long (default 5s)

## Usage Examples

### Example 1: Next.js Dev Server

1. Start Next.js on port 3000:
   ```bash
   npm run dev
   ```

2. Configure tunnel in `.knowhow/knowhow.json`:
   ```json
   {
     "worker": {
       "tunnel": {
         "enabled": true,
         "allowedPorts": [3000]
       }
     }
   }
   ```

3. Start worker:
   ```bash
   knowhow worker
   ```

4. The remote server can now proxy requests to your localhost:3000

### Example 2: Multiple Services

```json
{
  "worker": {
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 8080, 5173],
      "maxConcurrentStreams": 100
    }
  }
}
```

This allows:
- Port 3000: Next.js dev server
- Port 8080: API backend
- Port 5173: Vite dev server

### Example 3: WebSocket Support (HMR)

### Example 4: Docker Sandbox with Port Mapping

When running the worker in Docker sandbox mode (`knowhow worker --sandbox`), you need to configure port mapping to access services on the host machine.

**Scenario:** Next.js dev server running on host machine at port 3000, worker running in Docker.

1. **Host machine** - Start Next.js:
   ```bash
   npm run dev  # Runs on localhost:3000
   ```

2. **Configure tunnel** in `.knowhow/knowhow.json`:
   ```json
   {
     "worker": {
       "sandbox": true,
       "tunnel": {
         "enabled": true,
         "allowedPorts": [3000],
         "localHost": "host.docker.internal"
       }
     }
   }
   ```

3. **Start worker in sandbox:**
   ```bash
   knowhow worker --sandbox
   ```

The worker will automatically:
- Detect it's running in Docker
- Use `host.docker.internal` to reach host services
- Proxy requests from remote server to `host.docker.internal:3000`

**Alternative with Port Mapping:**
If your Docker setup doesn't support `host.docker.internal`, or you need to map ports:

```json
{
  "worker": {
    "sandbox": true,
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000],
      "portMapping": {
        "3000": 3000
      },
      "localHost": "172.17.0.1"
    }
  }
}
```

Where `172.17.0.1` is typically the Docker bridge network gateway (use `ip addr show docker0` to find it).

**Port Mapping Use Cases:**

1. **Service running on different port:**
   ```json
   {
     "portMapping": {
       "3000": 8080  // Remote requests port 3000 → local port 8080
     }
   }
   ```

2. **Multiple services with port conflicts:**
   ```json
   {
     "allowedPorts": [3000, 3001, 3002],
     "portMapping": {
       "3000": 4000,  // Frontend
       "3001": 4001,  // API
       "3002": 4002   // WebSocket server
     }
   }
   ```

### Example 5: WebSocket Support (HMR)

WebSocket connections are automatically handled. For example, Next.js HMR WebSocket will work seamlessly:

```
http://localhost:3000/_next/webpack-hmr (WebSocket)
```

The tunnel will:
1. Detect the WebSocket upgrade request
2. Establish a WebSocket connection to localhost:3000
3. Proxy all WebSocket frames bidirectionally

## Monitoring

The worker logs tunnel activity:

```
🌐 Tunnel enabled for ports: 3000, 8080
🌐 Tunnel handler initialized
New request: GET /api/users on port 3000 (stream: abc-123)
Response 200 for stream abc-123
Stream abc-123 complete: 1.2 KB sent, 45ms
```

To get tunnel statistics programmatically:

```typescript
import { createTunnelHandler } from "@tyvm/knowhow-tunnel";

const tunnel = createTunnelHandler(ws, config);
const stats = tunnel.getStats();

console.log(stats);
// {
//   activeStreams: 5,
//   totalStreamsHandled: 142,
//   bytesReceived: 12345,
//   bytesSent: 98765
// }
```

## Troubleshooting

### Port not accessible

**Error:** `Port 3000 is not allowed`

**Solution:** Add the port to `allowedPorts`:
```json
{
  "tunnel": {
    "enabled": true,
    "allowedPorts": [3000]
  }
}
```

### Connection refused

**Error:** `Connection refused`

**Causes:**
1. Service not running on that port
2. Service not listening on 127.0.0.1

**Solutions:**
1. Start the service: `npm run dev`
2. Ensure service binds to localhost:
   ```bash
   # Good
   next dev -H 127.0.0.1 -p 3000
   
   # Also works
   next dev -p 3000
   ```

### Timeout errors

**Error:** `Connection timeout`

**Solution:** Increase timeout in tunnel configuration (requires code change):
```typescript
createTunnelHandler(ws, {
  connectTimeout: 10000,  // 10 seconds
  idleTimeout: 120000,    // 2 minutes
});
```

### Too many streams

**Error:** `Too many concurrent streams`

**Solution:** Increase `maxConcurrentStreams`:
```json
{
  "tunnel": {
    "maxConcurrentStreams": 100
  }
}
```

## Protocol Details

The tunnel uses JSON messages over WebSocket. See the [main README](./README.md) for protocol specification.

## Performance Tips

1. **Use streaming responses**: Large files are streamed with proper backpressure
2. **Enable compression**: The tunnel respects `Accept-Encoding` headers
3. **Limit concurrent streams**: Set `maxConcurrentStreams` based on your machine's capacity
4. **Monitor memory**: Large responses are streamed, not buffered entirely

## Limitations

1. **Localhost only**: Cannot proxy to other machines or containers
2. **HTTP/WebSocket only**: No raw TCP support
3. **Single host**: All ports must be on 127.0.0.1
4. **No TLS termination**: Server must handle HTTPS if needed

## Advanced Usage

### Custom Configuration

For advanced use cases, you can modify the tunnel handler in `src/worker.ts`:

```typescript
tunnelHandler = createTunnelHandler(ws, {
  allowedPorts: [3000],
  maxConcurrentStreams: 50,
  maxResponseSize: 200 * 1024 * 1024,  // 200MB
  connectTimeout: 10000,
  idleTimeout: 120000,
  forceIdentityEncoding: false,  // Allow compression
  logLevel: "debug",
});
```

### Docker Integration

When using `knowhow worker --sandbox`, the tunnel runs inside Docker. Ensure your services are accessible from the container:

```bash
# Start service accessible to Docker
npm run dev -- -H 0.0.0.0 -p 3000
```

Then configure Docker port mapping in `.knowhow/Dockerfile.worker` or worker config.
