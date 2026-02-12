import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { SwaggerSpec, Tool } from "./types";
import { generateToolsFromSwagger, validateBaseUrl } from "./core";
import { DynamicSwaggerClient } from "./core/execute";

/**
 * Interface for swagger storage functions that must be provided by the consuming application
 */
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

/**
 * Create a dynamic MCP server from a swagger spec
 */
function createDynamicMcpServer(
  swaggerSpec: SwaggerSpec,
  baseUrl: string,
  requestHeaders?: Record<string, string>
): Server {
  const tools = generateToolsFromSwagger(swaggerSpec);
  const serverName = swaggerSpec.info.title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
  const serverVersion = swaggerSpec.info.version;

  const server = new Server(
    {
      name: `${serverName}-mcp-proxy`,
      version: serverVersion,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const client = new DynamicSwaggerClient(
    baseUrl,
    swaggerSpec,
    requestHeaders || {}
  );

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as any;

    try {
      const result = await client.callOperation(name, args || {});

      return {
        content: [
          {
            type: "text",
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: error.message,
          },
        ],
      };
    }
  });

  // Handle tool list requests
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  return server;
}

/**
 * Create Express middleware for stateless MCP proxy
 *
 * @param storage - SwaggerStorage implementation for database operations
 * @returns Express router with proxy endpoints
 */
export function statelessProxy(storage: SwaggerStorage): express.Router {
  const router = express.Router();

  // Middleware to parse JSON bodies
  router.use(express.json({ limit: "10mb" }));

  /**
   * POST /register
   * Register a swagger spec and return its hash
   */
  router.post(
    "/register",
    async (req: express.Request, res: express.Response) => {
      try {
        const swaggerSpec = req.body;

        // Basic validation
        if (!swaggerSpec || typeof swaggerSpec !== "object") {
          return res
            .status(400)
            .json({ error: "Invalid swagger spec: must be a JSON object" });
        }

        if (!swaggerSpec.swagger && !swaggerSpec.openapi) {
          return res.status(400).json({
            error: "Invalid swagger spec: missing swagger or openapi version",
          });
        }

        if (!swaggerSpec.info || !swaggerSpec.info.title) {
          return res
            .status(400)
            .json({ error: "Invalid swagger spec: missing info.title" });
        }

        if (!swaggerSpec.paths || typeof swaggerSpec.paths !== "object") {
          return res
            .status(400)
            .json({ error: "Invalid swagger spec: missing or invalid paths" });
        }

        // Register the spec
        const hash = await storage.registerSwagger(swaggerSpec);

        res.json({ hash });
      } catch (error: any) {
        console.error("Error registering swagger spec:", error);
        res
          .status(500)
          .json({ error: error.message || "Failed to register swagger spec" });
      }
    }
  );

  /**
   * GET /:swaggerHash
   * Retrieve a swagger spec by hash
   */
  router.get(
    "/:swaggerHash",
    async (req: express.Request, res: express.Response) => {
      try {
        const { swaggerHash } = req.params;

        if (!swaggerHash) {
          return res
            .status(400)
            .json({ error: "Missing swaggerHash parameter" });
        }

        const swaggerSpec = await storage.getSwagger(swaggerHash);

        if (!swaggerSpec) {
          return res.status(404).json({ error: "Swagger spec not found" });
        }

        res.json(swaggerSpec);
      } catch (error: any) {
        console.error("Error retrieving swagger spec:", error);
        res
          .status(500)
          .json({ error: error.message || "Failed to retrieve swagger spec" });
      }
    }
  );

  /**
   * POST /:swaggerHash?baseUrl=xxx
   * Serve MCP server for the swagger spec at the given baseUrl
   *
   * This endpoint accepts MCP protocol messages in the request body
   * and returns MCP protocol responses.
   */
  router.post(
    "/:swaggerHash",
    async (req: express.Request, res: express.Response) => {
      try {
        const { swaggerHash } = req.params;
        const { baseUrl } = req.query;

        if (!swaggerHash) {
          return res
            .status(400)
            .json({ error: "Missing swaggerHash parameter" });
        }

        if (!baseUrl || typeof baseUrl !== "string") {
          return res
            .status(400)
            .json({ error: "Missing or invalid baseUrl query parameter" });
        }

        // Retrieve swagger spec
        const swaggerSpec = await storage.getSwagger(swaggerHash);

        if (!swaggerSpec) {
          return res.status(404).json({ error: "Swagger spec not found" });
        }

        // Validate baseUrl for SSRF protection
        const validationError = validateBaseUrl(baseUrl, swaggerSpec);
        if (validationError) {
          return res.status(400).json({ error: validationError });
        }

        // Extract authentication headers to pass through
        const authHeaders: Record<string, string> = {};
        const headerKeys = [
          "authorization",
          "x-api-key",
          "api-key",
          "apikey",
          "x-auth-token",
        ];

        for (const key of headerKeys) {
          const value = req.headers[key.toLowerCase()];
          if (value) {
            authHeaders[key] = Array.isArray(value) ? value[0] : value;
          }
        }

        // Create dynamic MCP server
        const mcpServer = createDynamicMcpServer(
          swaggerSpec,
          baseUrl,
          authHeaders
        );

        // Parse MCP request from body
        const mcpRequest = req.body;

        if (!mcpRequest || typeof mcpRequest !== "object") {
          return res
            .status(400)
            .json({ error: "Invalid MCP request: must be a JSON object" });
        }

        // Handle MCP protocol messages
        // The MCP server expects messages in JSON-RPC 2.0 format
        if (!mcpRequest.jsonrpc || mcpRequest.jsonrpc !== "2.0") {
          return res.status(400).json({
            jsonrpc: "2.0",
            id: mcpRequest.id || null,
            error: {
              code: -32600,
              message: "Invalid Request: missing or invalid jsonrpc version",
            },
          });
        }

        if (!mcpRequest.method || typeof mcpRequest.method !== "string") {
          return res.status(400).json({
            jsonrpc: "2.0",
            id: mcpRequest.id || null,
            error: {
              code: -32600,
              message: "Invalid Request: missing or invalid method",
            },
          });
        }

        // Route the request to the appropriate handler
        let response: any;

        try {
          if (mcpRequest.method === "tools/list") {
            const tools = generateToolsFromSwagger(swaggerSpec);
            response = {
              jsonrpc: "2.0",
              id: mcpRequest.id,
              result: {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              },
            };
          } else if (mcpRequest.method === "tools/call") {
            const params = mcpRequest.params || {};
            const { name, arguments: args } = params;

            if (!name) {
              return res.status(400).json({
                jsonrpc: "2.0",
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: "Invalid params: missing tool name",
                },
              });
            }

            const client = new DynamicSwaggerClient(
              baseUrl,
              swaggerSpec,
              authHeaders
            );
            const result = await client.callOperation(name, args || {});

            response = {
              jsonrpc: "2.0",
              id: mcpRequest.id,
              result: {
                content: [
                  {
                    type: "text",
                    text:
                      typeof result === "string"
                        ? result
                        : JSON.stringify(result, null, 2),
                  },
                ],
              },
            };
          } else if (mcpRequest.method === "initialize") {
            // Handle MCP initialization
            response = {
              jsonrpc: "2.0",
              id: mcpRequest.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: {
                  tools: {},
                },
                serverInfo: {
                  name: `${swaggerSpec.info.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "-")}-mcp-proxy`,
                  version: swaggerSpec.info.version,
                },
              },
            };
          } else {
            // Unsupported method
            response = {
              jsonrpc: "2.0",
              id: mcpRequest.id,
              error: {
                code: -32601,
                message: `Method not found: ${mcpRequest.method}`,
              },
            };
          }
        } catch (error: any) {
          console.error("Error handling MCP request:", error);
          response = {
            jsonrpc: "2.0",
            id: mcpRequest.id,
            error: {
              code: -32603,
              message: error.message || "Internal error",
            },
          };
        }

        res.json(response);
      } catch (error: any) {
        console.error("Error in MCP proxy:", error);
        res.status(500).json({
          jsonrpc: "2.0",
          id: req.body?.id || null,
          error: {
            code: -32603,
            message: error.message || "Internal server error",
          },
        });
      }
    }
  );

  return router;
}
