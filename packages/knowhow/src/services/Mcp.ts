import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Anthropic from "@anthropic-ai/sdk";

import { McpConfig } from "../types";
import { Tool } from "../clients";
import { getConfig } from "../config";
import { ToolsService } from "./Tools";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCPWebSocketTransport } from "./McpWebsocketTransport";

type CachedTool = Anthropic.Tool;
export type McpTool = CachedTool & {
  inputSchema: CachedTool["input_schema"];
};

export const knowhowMcpClient = {
  name: "knowhow-mcp-client",
  version: "1.0.0",
};
export const knowhowConfig = {
  capabilities: {
    prompts: {},
    resources: {},
    tools: {},
  },
};

export * from "./McpServer";
export * from "./McpWebsocketTransport";

export class McpService {
  connected = [];
  transports: Transport[] = [];
  clients: Client[] = [];
  config: McpConfig[] = [];
  tools: Tool[] = [];
  mcpPrefix = "mcp";

  async createStdioClients(mcpServers: McpConfig[] = []) {
    if (this.clients.length) {
      return this.clients;
    }

    this.config = mcpServers;
    this.transports = mcpServers.map((mcp) => {
      const logFormat = `${mcp.name}: Command: ${mcp.command}, Args: ${mcp.args}, URL: ${mcp.url}`;

      console.log("Creating transport for", logFormat);
      if (mcp.command) {
        return new StdioClientTransport(mcp as StdioServerParameters);
      }
      if (mcp?.params?.socket) {
        return new MCPWebSocketTransport(mcp.params.socket);
      }
      if (mcp.url) {
        return new StreamableHTTPClientTransport(new URL(mcp.url));
      }
    });

    this.clients = this.transports.map((transport) => {
      return new Client(knowhowMcpClient, knowhowConfig);
    });

    return this.clients;
  }

  setMcpPrefix(prefix: string) {
    this.mcpPrefix = prefix;
  }

  createClient(mcp: McpConfig, transport: Transport) {
    this.config.push(mcp);
    this.clients.push(new Client(knowhowMcpClient, knowhowConfig));
    this.transports.push(transport);
  }

  async connectToConfigured(tools?: ToolsService) {
    const config = await getConfig();

    return this.connectTo(config.mcps, tools);
  }

  async connectTo(mcpServers: McpConfig[] = [], tools?: ToolsService) {
    const clients = await this.createStdioClients(mcpServers);
    await this.connectAll();

    if (tools) {
      await this.addTools(tools);
    }
  }

  async addTools(tools: ToolsService) {
    tools.addTools(await this.getTools());
    tools.addFunctions(await this.getToolMap());
  }

  async copyFrom(mcp: McpService) {
    this.clients.push(...mcp.clients);
    this.transports.push(...mcp.transports);
    this.config.push(...mcp.config);
    this.connected.push(...mcp.connected);
  }

  async closeTransports() {
    await Promise.all(
      this.transports.map(async (transport, index) => {
        this.connected[index] = false;
        return transport.close();
      })
    );

    this.transports = [];
    this.connected = [];
  }

  async closeClients() {
    await Promise.all(
      this.clients.map((client) => {
        return client.close();
      })
    );

    this.clients = [];
    this.connected = [];
  }

  async closeAll() {
    await this.closeTransports();
    await this.closeClients();
  }

  getClientIndex(clientName: string) {
    const index = this.config.findIndex((mcp) => mcp.name === clientName);
    return index;
  }

  parseToolName(toolName: string) {
    const split = toolName.split("_");

    if (split.length < 2) {
      return null;
    }

    return split.slice(2).join("_");
  }

  getToolClientIndex(toolName: string) {
    const split = toolName.split("_");

    if (split.length < 2) {
      return -1;
    }

    const index = Number(split[1]);
    return index;
  }

  getToolClient(toolName: string) {
    const index = this.getToolClientIndex(toolName);

    if (index < 0) {
      throw new Error(`Invalid tool name ${toolName}`);
    }

    return this.clients[index];
  }

  getFunction(toolName: string) {
    const client = this.getToolClient(toolName);

    const realName = this.parseToolName(toolName);
    return async (args: any) => {
      console.log("Calling tool", realName, "with args", args);
      const tool = await client.callTool(
        {
          name: realName,
          arguments: args,
        },
        CallToolResultSchema,
        {
          timeout: 10 * 60 * 1000,
          maxTotalTimeout: 10 * 60 * 1000,
        }
      );
      return tool;
    };
  }

  async getFunctions() {
    const tools = await this.getTools();
    return tools.map((tool) => {
      return this.getFunction(tool.function.name);
    });
  }

  async getToolMap() {
    const tools = await this.getTools();
    return tools.reduce((acc, tool) => {
      acc[tool.function.name] = this.getFunction(tool.function.name);
      return acc;
    }, {});
  }

  async connectAll() {
    await Promise.all(
      this.clients.map(async (client, index) => {
        if (this.connected[index]) {
          return;
        }
        await client.connect(this.transports[index]);
        this.connected[index] = true;
      })
    );
  }

  async getClient() {
    if (this.clients.length) {
      return this.clients;
    }

    this.clients = await this.createStdioClients(this.config);

    return this.clients;
  }

  async getTools() {
    if (this.tools.length) {
      return this.tools;
    }

    const tools = [] as Tool[];

    for (let i = 0; i < this.config.length; i++) {
      const config = this.config[i];
      const client = this.clients[i];
      const clientTools = await client.listTools();
      const transformedTools = clientTools.tools.map((tool) => {
        return this.toOpenAiTool(i, tool as any as McpTool);
      });
      tools.push(...transformedTools);
    }

    this.tools = tools;
    return tools;
  }

  toOpenAiTool(index: number, tool: McpTool) {
    const transformed: Tool = {
      type: "function",
      function: {
        name: `${this.mcpPrefix}_${index}_${tool.name}`,
        description: tool.description,
        parameters: {
          type: "object",
          positional: Boolean(tool.inputSchema.positional),
          properties: tool.inputSchema.properties as any,
          required: tool.inputSchema.required as string[],
        },
      },
    };

    return transformed;
  }
}

export const Mcp = new McpService();
