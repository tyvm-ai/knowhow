import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Tool, ToolProp } from "../clients/types";
import { ToolsService } from "./Tools";
import { MCPWebSocketTransport } from "./McpWebsocketTransport";
import { WebSocket } from "ws";

export class McpServerService {
  server: McpServer | null = null;
  constructor(private toolsService: ToolsService) {}
  registeredTools = new Set<string>();

  createServer(name: string, version: string) {
    if (this.server) {
      return this;
    }

    this.server = new McpServer({
      name,
      version,
    });

    return this;
  }

  toZodSchema(
    properties: { [key: string]: ToolProp },
    required?: string[]
  ): z.ZodObject<any> {
    const schema: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value.type === "string") {
        schema[key] = z.string();
      } else if (value.type === "number") {
        schema[key] = z.number();
      } else if (value.type === "boolean") {
        schema[key] = z.boolean();
      } else if (value.type === "array" && value?.items?.properties) {
        schema[key] = z.array(this.toZodSchema(value.items.properties, required));
      } else if (value.type === "object" && value.properties) {
        schema[key] = this.toZodSchema(value.properties, required);
      } else {
        schema[key] = z.any();
      }
      
      // Make field optional if it's not in the required array
      if (required && !required.includes(key)) {
        schema[key] = schema[key].optional();
      }
    }
    
    return z.object(schema);
  }

  withTools(tools: Tool[]) {
    for (const tool of tools) {
      const props = tool.function.parameters.properties;
      const required = tool.function.parameters.required;

      if (!props) {
        console.warn(`Tool ${tool.function.name} has no properties`);
        continue;
      }

      if (this.registeredTools.has(tool.function.name)) {
        console.log(`Tool ${tool.function.name} already registered`);
        continue;
      }

      console.log(`Registering tool ${tool.function.name}`);
      this.registeredTools.add(tool.function.name);

      const shape = this.toZodSchema(props, required).shape;

      this.server.tool(
        tool.function.name,
        tool.function.description,
        shape,
        async (args, extra) => {
          const fn = this.toolsService.getFunction(tool.function.name);

          let response = "" as string | any;
          if (tool.function.parameters.positional) {
            response = await fn(...Object.values(args));
          } else {
            response = await fn(args);
          }

          if (response && typeof response === "object" && response.content) {
            return response;
          }

          return {
            content: [
              {
                type: "text",
                text:
                  typeof response === "string"
                    ? response
                    : JSON.stringify(response),
              },
            ],
          };
        }
      );
    }
    return this;
  }

  createServerWithAllTools(name: string, version: string) {
    return this.createServer(name, version).withTools(
      this.toolsService.getTools()
    );
  }

  async runStdioServer() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`MCP Server running on stdio`);
  }

  async runWsServer(ws: WebSocket) {
    const transport = new MCPWebSocketTransport(ws);
    await this.server.connect(transport);
    console.error(`MCP Server running on websocket`);
  }
}
