import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Anthropic from "@anthropic-ai/sdk";

import fs from "fs";
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

/*
 *
 * McpService is a service that manages connections to multiple MCP servers.
 * Allows us to connect the tools exposed by MCP servers to our internal ToolService, which agents can use.
 * Each of the tools are namespaced with a prefix: mcp_index_servername_toolName
 * This services handles calls made to the namespaced function name, and finds the proper client to call the tool on.
 */
export class McpService {
  connected = [];
  transports: Transport[] = [];
  clients: Client[] = [];
  config: McpConfig[] = [];
  tools: Tool[] = [];
  mcpPrefix = "mcp";
  toolAliases: Record<string, string> = {};

  async createStdioClients(mcpServers: McpConfig[] = []) {
    if (this.clients.length) {
      return this.clients;
    }

    this.config = mcpServers;
    this.transports = mcpServers.map((mcp) => {
      const commandString = mcp.command
        ? `${mcp.command} ${mcp.args?.join(" ")}`
        : "";
      const logFormat = `${mcp.name}: Command: ${commandString}, URL: ${mcp.url}`;

      console.log("Creating transport for", logFormat);
      if (mcp.command) {
        const stdioParams: StdioServerParameters = {
          command: mcp.command,
          args: mcp.args,
          env: mcp.env
            ? {
                ...process.env,
                ...mcp.env,
              }
            : undefined,
        };
        return new StdioClientTransport(stdioParams);
      }
      if (mcp?.params?.socket) {
        return new MCPWebSocketTransport(mcp.params.socket);
      }
      if (mcp.url) {
        // TODO: also support refresh tokens
        if (mcp.authorization_token_file) {
          const token = fs.readFileSync(mcp.authorization_token_file, "utf-8");
          mcp.authorization_token = token.trim();
        }

        return new StreamableHTTPClientTransport(new URL(mcp.url), {
          requestInit: {
            headers: {
              "User-Agent": knowhowMcpClient.name,
              ...(mcp.authorization_token && {
                Authorization: `Bearer ${mcp.authorization_token}`,
              }),
            },
          },
        });
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
    await this.connectAutoServers();

    if (tools) {
      await this.addTools(tools);
    }
  }

  // Connect only servers with autoConnect !== false
  async connectAutoServers() {
    const results = await Promise.allSettled(
      this.clients.map(async (client, index) => {
        const config = this.config[index];
        const shouldAutoConnect = config.autoConnect !== false;

        if (shouldAutoConnect && !this.connected[index]) {
          console.log(`Connecting to MCP server: ${config.name}`);
          try {
            await client.connect(this.transports[index]);
          } catch (error) {
            console.error(
              `Failed to connect to MCP server '${config.name}':`,
              error.message || error
            );
            throw error; // Re-throw to mark as rejected in Promise.allSettled
          }
          this.connected[index] = true;
        } else if (!shouldAutoConnect) {
          console.log(
            `Skipping auto-connect for MCP server: ${config.name} (autoConnect: false)`
          );
        }
      })
    );

    // Log summary of auto-connection results
    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.warn(
        `Auto-connected ${successful}/${this.clients.length} MCP servers (${failed} failed)`
      );
    }
  }

  // Connect to a specific MCP server by name
  async connectSingle(
    serverName: string,
    timeout: number = 30000
  ): Promise<{
    success: boolean;
    toolsAdded: string[];
    error?: string;
  }> {

    const index = this.getClientIndex(serverName);

    if (index < 0) {
      return {
        success: false,
        toolsAdded: [],
        error: `MCP server '${serverName}' not found in configuration`,
      };
    }

    if (this.connected[index]) {
      return {
        success: true,
        toolsAdded: [],
        error: `MCP server '${serverName}' already connected`,
      };
    }

    try {
      const client = this.clients[index];
      const transport = this.transports[index];

      // Connect with timeout
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Connection timeout")), timeout)
        ),
      ]);

      this.connected[index] = true;

      // Get tools from this server
      const clientTools = await client.listTools();
      const toolNames: string[] = [];

      for (const tool of clientTools.tools) {
        const transformed = this.toOpenAiTool(index, tool as any);
        if (transformed.function.name !== tool.name) {
          this.toolAliases[transformed.function.name] = tool.name;
        }
        toolNames.push(transformed.function.name);

        // Add to cache if not already present
        if (
          !this.tools.find((t) => t.function.name === transformed.function.name)
        ) {
          this.tools.push(transformed);
        }
      }

      return {
        success: true,
        toolsAdded: toolNames,
      };
    } catch (error) {
      return {
        success: false,
        toolsAdded: [],
        error: error.message,
      };
    }
  }

  // Disconnect a specific MCP server
  async disconnectSingle(serverName: string): Promise<{
    success: boolean;
    toolsRemoved: string[];
    error?: string;
  }> {
    const index = this.getClientIndex(serverName);

    if (index < 0) {
      return {
        success: false,
        toolsRemoved: [],
        error: `MCP server '${serverName}' not found`,
      };
    }

    if (!this.connected[index]) {
      return {
        success: true,
        toolsRemoved: [],
        error: `MCP server '${serverName}' not connected`,
      };
    }

    try {
      const toolsToRemove = this.tools
        .filter((t) => this.getToolClientIndex(t.function.name) === index)
        .map((t) => t.function.name);

      // Close connection
      await this.transports[index]?.close();
      this.connected[index] = false;

      // Remove tools from cache
      this.tools = this.tools.filter(
        (t) => this.getToolClientIndex(t.function.name) !== index
      );

      return {
        success: true,
        toolsRemoved: toolsToRemove,
      };
    } catch (error) {
      return {
        success: false,
        toolsRemoved: [],
        error: error.message,
      };
    }
  }

  // Get available servers (connected and disconnected)
  getAvailableServers() {
    return this.config.map((config, index) => {
      const toolCount = this.connected[index]
        ? this.tools.filter(
            (t) => this.getToolClientIndex(t.function.name) === index
          ).length
        : 0;

      return {
        name: config.name,
        connected: this.connected[index] || false,
        autoConnect: config.autoConnect !== false,
        toolCount,
      };
    });
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
        return transport && transport.close();
      })
    );

    // this.transports = [];
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

  parseToolName(wrappedName: string) {
    return this.toolAliases[wrappedName] || wrappedName;
  }

  getToolClientIndex(toolName: string) {
    if (this.clients.length <= 1) {
      return 0;
    }

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

  getFunction(toolName: string, timeout?: number) {
    const client = this.getToolClient(toolName);

    // Handle unwrapped tool names if we have 1 client
    if (
      !this.toolAliases[toolName] &&
      !toolName.startsWith(this.mcpPrefix) &&
      this.clients.length === 1
    ) {
      // Assume first client if no index is specified
      const wrappedName = this.getWrappedFunctionName(toolName, 0);
      toolName = this.toolAliases[wrappedName] ? wrappedName : toolName;
    }

    const realName = this.parseToolName(toolName);
    return async (args: any) => {
      console.log("Calling tool via mcp client", realName, "with args", args);
      const tool = await client.callTool(
        {
          name: realName,
          arguments: args,
        },
        CallToolResultSchema,
        {
          timeout: timeout || 10 * 60 * 1000,
          maxTotalTimeout: timeout || 10 * 60 * 1000,
        }
      );
      return tool;
    };
  }

  /**
   * Call a function and unwrap the MCP response content array with type casting
   * @param toolName The name of the tool/function to call
   * @param args The arguments to pass to the function
   * @returns The parsed result with type T
   */
  async callFunction<T = any>(toolName: string, args: any = {}): Promise<T> {
    try {
      const fn = this.getFunction(toolName);
      const result = await fn(args);

      // Parse the MCP result
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content.find((c: any) => c.type === "text");
        if (textContent && textContent.text) {
          const parsedResult = JSON.parse(textContent.text);
          return parsedResult as T;
        }
      }

      throw new Error(
        `Invalid response format from MCP service for tool ${toolName}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to call MCP function ${toolName}: ${errorMessage}`
      );
    }
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
    const results = await Promise.allSettled(
      this.clients.map(async (client, index) => {
        const config = this.config[index];
        if (this.connected[index]) {
          return;
        }
        try {
          await client.connect(this.transports[index]);
        } catch (error) {
          console.error(
            `Failed to connect to MCP server '${config?.name || `index ${index}`}':`,
            error.message || error
          );
          throw error; // Re-throw to mark as rejected in Promise.allSettled
        }
        this.connected[index] = true;
      })
    );

    // Log summary of connection results
    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.warn(
        `Connected ${successful}/${this.clients.length} MCP servers (${failed} failed)`
      );
    }
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

      if (!this.connected[i]) {
        // skip adding tools for unconnected clients
        continue;
      }
      const clientTools = await client.listTools();

      for (const tool of clientTools.tools) {
        const transformed = this.toOpenAiTool(i, tool as any as McpTool);
        if (transformed.function.name !== tool.name) {
          this.toolAliases[transformed.function.name] = tool.name;
        }
        tools.push(transformed);
      }
    }

    this.tools = tools;
    return tools;
  }

  getToolPrefix(index = 0) {
    const mcpName = this.config[index]?.name
      ?.toLowerCase()
      ?.replaceAll(" ", "_");

    const prefix = mcpName
      ? `${this.mcpPrefix}_${index}_${mcpName}`
      : `${this.mcpPrefix}_${index}`;

    return prefix;
  }

  // Wrapping tools with a prefix to avoid name collisions across many mcp servers
  getWrappedFunctionName(toolName: string, index = 0) {
    const prefix = this.getToolPrefix(index);
    return `${prefix}_${toolName}`;
  }

  toOpenAiTool(index: number, tool: McpTool) {
    const name = this.getWrappedFunctionName(tool.name, index);

    const transformed: Tool = {
      type: "function",
      function: {
        name,
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
