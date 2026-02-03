/**
 * Example: Simple MCP Proxy Server
 * 
 * This example demonstrates how to set up a stateless MCP proxy server
 * that can dynamically serve tools from any registered Swagger/OpenAPI specification.
 */

import express from 'express';
import { statelessProxy, SwaggerStorage, SwaggerSpec } from '../src/proxy-runtime';
import { createHash } from 'crypto';

/**
 * Simple in-memory implementation of SwaggerStorage
 * In production, use a database like PostgreSQL, MongoDB, or Redis
 */
class InMemorySwaggerStorage implements SwaggerStorage {
  private specs = new Map<string, SwaggerSpec>();

  async registerSwagger(swaggerDef: SwaggerSpec): Promise<string> {
    // Create a deterministic hash from the swagger spec
    const hash = createHash('sha256')
      .update(JSON.stringify(swaggerDef))
      .digest('hex')
      .substring(0, 16);
    
    this.specs.set(hash, swaggerDef);
    console.log(`✅ Registered swagger spec with hash: ${hash}`);
    
    return hash;
  }

  async getSwagger(swaggerHash: string): Promise<SwaggerSpec | null> {
    return this.specs.get(swaggerHash) || null;
  }

  // Helper method for development
  listAll(): string[] {
    return Array.from(this.specs.keys());
  }
}

/**
 * Create and configure the Express application
 */
function createProxyServer() {
  const app = express();
  const storage = new InMemorySwaggerStorage();

  // Mount the MCP proxy at /mcp-proxy
  app.use('/mcp-proxy', statelessProxy(storage));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Development: List registered specs
  app.get('/debug/specs', (req, res) => {
    res.json({ specs: (storage as InMemorySwaggerStorage).listAll() });
  });

  return { app, storage };
}

/**
 * Start the server
 */
async function main() {
  const { app, storage } = createProxyServer();
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`
🚀 MCP Proxy Server running on http://localhost:${PORT}

📝 Endpoints:
  POST   /mcp-proxy/register              - Register a swagger spec
  GET    /mcp-proxy/:hash                 - Get a swagger spec
  POST   /mcp-proxy/:hash?baseUrl=...     - Serve MCP tools
  GET    /health                          - Health check
  GET    /debug/specs                     - List registered specs (dev)

📖 Example usage:

1. Register a swagger spec:
   curl -X POST http://localhost:${PORT}/mcp-proxy/register \\
     -H "Content-Type: application/json" \\
     -d @your-swagger.json

2. Initialize MCP session:
   curl -X POST 'http://localhost:${PORT}/mcp-proxy/YOUR_HASH?baseUrl=https://api.example.com' \\
     -H "Content-Type: application/json" \\
     -H "Authorization: Bearer your-token" \\
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

3. List tools:
   curl -X POST 'http://localhost:${PORT}/mcp-proxy/YOUR_HASH?baseUrl=https://api.example.com' \\
     -H "Content-Type: application/json" \\
     -d '{ "jsonrpc": "2.0", "method": "tools/list", "id": 2 }'

4. Call a tool:
   curl -X POST 'http://localhost:${PORT}/mcp-proxy/YOUR_HASH?baseUrl=https://api.example.com' \\
     -H "Content-Type: application/json" \\
     -d '{
       "jsonrpc": "2.0",
       "method": "tools/call",
       "id": 3,
       "params": { "name": "operationId", "arguments": {} }
     }'
    `);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    process.exit(0);
  });
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}

export { createProxyServer, InMemorySwaggerStorage };
