# Stateless Swagger MCP Proxy

The proxy runtime allows you to dynamically serve MCP tools from any Swagger/OpenAPI specification without needing to generate and deploy separate containers for each API.

## Overview

Instead of:
1. Generate code for each API
2. Build and deploy separate containers
3. Manage multiple deployments

You can:
1. Register a swagger spec once
2. Serve MCP tools dynamically at runtime
3. Single proxy handles all APIs

## Architecture

The proxy consists of three main endpoints:

### 1. Register Swagger Spec
**POST `/mcp-proxy/register`**

Register a swagger specification and receive a hash identifier.

```typescript
import express from 'express';
import { statelessProxy, SwaggerStorage } from '@tyvm/swagger-mcp';

const app = express();

// Implement storage interface (example using in-memory storage)
class MySwaggerStorage implements SwaggerStorage {
  private specs = new Map();
  
  async registerSwagger(swaggerDef) {
    const hash = createHash(swaggerDef); // Your hashing logic
    await db.save(hash, swaggerDef);
    return hash;
  }
  
  async getSwagger(hash) {
    return await db.get(hash);
  }
}

const storage = new MySwaggerStorage();
app.use('/mcp-proxy', statelessProxy(storage));

app.listen(3000);
```

Request:
```bash
curl -X POST http://localhost:3000/mcp-proxy/register \
  -H "Content-Type: application/json" \
  -d @swagger.json
```

Response:
```json
{
  "hash": "abc123def456"
}
```

### 2. Retrieve Swagger Spec
**GET `/mcp-proxy/:swaggerHash`**

Retrieve a previously registered swagger specification.

```bash
curl http://localhost:3000/mcp-proxy/abc123def456
```

### 3. Serve MCP Tools
**POST `/mcp-proxy/:swaggerHash?baseUrl=https://api.example.com`**

Dynamically serve MCP tools from the swagger spec at the specified baseUrl.

```bash
# Initialize MCP session
curl -X POST 'http://localhost:3000/mcp-proxy/abc123def456?baseUrl=https://api.example.com' \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "id": 1,
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "1.0.0" }
    }
  }'

# List available tools
curl -X POST 'http://localhost:3000/mcp-proxy/abc123def456?baseUrl=https://api.example.com' \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 2
  }'

# Call a tool
curl -X POST 'http://localhost:3000/mcp-proxy/abc123def456?baseUrl=https://api.example.com' \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "id": 3,
    "params": {
      "name": "getUsers",
      "arguments": {}
    }
  }'
```

## Security Features

### SSRF Protection

The proxy validates `baseUrl` to prevent Server-Side Request Forgery attacks:

- **Blocks localhost**: `localhost`, `127.0.0.1`, `::1`, `[::1]`
- **Blocks private IP ranges**:
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`
  - `169.254.0.0/16` (link-local)
- **Only allows http/https**: Blocks `file://`, `ftp://`, etc.
- **Validates against swagger spec**: baseUrl must match one of the servers defined in the swagger specification

### Authentication Pass-through

The proxy automatically forwards authentication headers to the target API:
- `Authorization`
- `X-API-Key`
- `API-Key`
- `APIKey`
- `X-Auth-Token`

## SwaggerStorage Interface

You must implement the `SwaggerStorage` interface to persist swagger specifications:

```typescript
export interface SwaggerStorage {
  /**
   * Register a swagger definition and return its hash
   * @param swaggerDef The swagger/OpenAPI specification
   * @returns Promise resolving to the hash identifier
   */
  registerSwagger(swaggerDef: SwaggerSpec): Promise<string>;
  
  /**
   * Retrieve a swagger definition by its hash
   * @param swaggerHash The hash identifier
   * @returns Promise resolving to the swagger specification or null if not found
   */
  getSwagger(swaggerHash: string): Promise<SwaggerSpec | null>;
}
```

### Example Database Implementation

```typescript
import { SwaggerStorage, SwaggerSpec } from '@tyvm/swagger-mcp';
import { createHash } from 'crypto';

class PostgresSwaggerStorage implements SwaggerStorage {
  constructor(private db: any) {}
  
  async registerSwagger(swaggerDef: SwaggerSpec): Promise<string> {
    // Create deterministic hash
    const hash = createHash('sha256')
      .update(JSON.stringify(swaggerDef))
      .digest('hex')
      .substring(0, 16);
    
    // Store in database
    await this.db.query(
      'INSERT INTO swagger_specs (hash, spec, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (hash) DO NOTHING',
      [hash, JSON.stringify(swaggerDef)]
    );
    
    return hash;
  }
  
  async getSwagger(swaggerHash: string): Promise<SwaggerSpec | null> {
    const result = await this.db.query(
      'SELECT spec FROM swagger_specs WHERE hash = $1',
      [swaggerHash]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return JSON.parse(result.rows[0].spec);
  }
}
```

## Integration Example

Complete example integrating the proxy into an Express application:

```typescript
import express from 'express';
import { statelessProxy, SwaggerStorage, SwaggerSpec } from '@tyvm/swagger-mcp';
import { createHash } from 'crypto';

// In-memory storage for development
class InMemoryStorage implements SwaggerStorage {
  private specs = new Map<string, SwaggerSpec>();
  
  async registerSwagger(swaggerDef: SwaggerSpec): Promise<string> {
    const hash = createHash('sha256')
      .update(JSON.stringify(swaggerDef))
      .digest('hex')
      .substring(0, 16);
    this.specs.set(hash, swaggerDef);
    return hash;
  }
  
  async getSwagger(hash: string): Promise<SwaggerSpec | null> {
    return this.specs.get(hash) || null;
  }
}

const app = express();
const storage = new InMemoryStorage();

// Mount the proxy
app.use('/mcp-proxy', statelessProxy(storage));

app.listen(3000, () => {
  console.log('MCP Proxy listening on http://localhost:3000');
});
```

## MCP Protocol Support

The proxy implements the following MCP protocol methods:

### `initialize`
Initializes an MCP session. Returns server capabilities and info.

### `tools/list`
Lists all available tools generated from the swagger specification.

### `tools/call`
Executes a tool (API operation) with the provided arguments.

## Error Handling

The proxy returns JSON-RPC 2.0 error responses:

- **-32600**: Invalid Request (malformed JSON-RPC)
- **-32601**: Method Not Found (unsupported MCP method)
- **-32602**: Invalid Params (missing required parameters)
- **-32603**: Internal Error (server error)

Example error response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params: missing tool name"
  }
}
```

## Testing

Run the test suite:

```bash
npm test -- proxy-runtime.test.ts
```

The tests cover:
- SSRF protection (blocking private IPs, localhost)
- Swagger registration and retrieval
- MCP protocol message handling
- Authentication header pass-through
- Error handling

## Performance Considerations

- **No code generation**: Tools are generated at runtime from swagger specs
- **Caching**: Consider caching generated tools per swagger hash
- **Connection pooling**: Reuse HTTP connections to target APIs
- **Rate limiting**: Add rate limiting to prevent abuse

## Limitations

- Only supports Swagger 2.0 and OpenAPI 3.x specifications
- baseUrl must match one of the servers in the swagger spec
- Does not support OAuth flows (use pre-obtained tokens)
- Does not support file uploads/downloads yet

## Next Steps

1. Implement caching for generated tools
2. Add metrics and logging
3. Support for more authentication methods
4. WebSocket support for streaming responses
