import { SwaggerMcpGenerator } from './generator';

export function generateExpressCompositionTemplate(generator: SwaggerMcpGenerator): string {
  const tools = generator.generateTools();
  const apiBaseUrl = generator.getApiBaseUrlPublic();
  const swaggerSpec = generator.getSwaggerSpec();
  const serverName = swaggerSpec.info.title.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const serverVersion = swaggerSpec.info.version;

  return `import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server-factory';

/**
 * Stateless Express app composition - creates new server instance for each request
 * @param app Express app instance to compose with
 * @param mcpPath Path for MCP endpoints (default: '/mcp')
 * @returns The same Express app instance for chaining
 */
export function statelessApp(app: express.Application, mcpPath: string = '/mcp'): express.Application {
  app.post(mcpPath, async (req: express.Request, res: express.Response) => {
    try {
      // Extract authorization header for API calls
      const authHeader = req.headers.authorization;
      const requestHeaders = authHeader ? { Authorization: authHeader } : undefined;
      
      const server = createMcpServer(requestHeaders);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      
      res.on('close', () => {
        console.log('Request closed');
        transport.close();
        server.close();
      });
      
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // SSE notifications not supported in stateless mode
  app.get(mcpPath, async (req: express.Request, res: express.Response) => {
    console.log('Received GET MCP request');
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    }));
  });

  // Session termination not needed in stateless mode
  app.delete(mcpPath, async (req: express.Request, res: express.Response) => {
    console.log('Received DELETE MCP request');
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    }));
  });

  return app;
}

/**
 * Stateful Express app composition - maintains session state across requests
 * @param app Express app instance to compose with
 * @param mcpPath Path for MCP endpoints (default: '/mcp')
 * @returns The same Express app instance for chaining
 */
export function statefulApp(app: express.Application, mcpPath: string = '/mcp'): express.Application {
  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Handle POST requests for client-to-server communication
  app.post(mcpPath, async (req: express.Request, res: express.Response) => {
    // Extract authorization header for API calls
    const authHeader = req.headers.authorization;
    const requestHeaders = authHeader ? { Authorization: authHeader } : undefined;
    
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID
          transports[sessionId] = transport;
        },
      });

      // Clean up transport when closed
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };
      
      const server = createMcpServer(requestHeaders);
      await server.connect(transport);
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  });

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get(mcpPath, handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete(mcpPath, handleSessionRequest);

  return app;
}
`;
}