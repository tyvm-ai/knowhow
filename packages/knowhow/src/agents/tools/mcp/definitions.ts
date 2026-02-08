import { Tool } from "../../../clients/types";

const listAvailableMcpServersDefinition: Tool = {
  type: "function",
  function: {
    name: "listAvailableMcpServers",
    description:
      "List all configured MCP servers and their connection status. Shows which servers are connected, which are disconnected, and how many tools each provides.",
    parameters: {
      type: "object",
      positional: true,
      properties: {},
      required: [],
    },
  },
};

const connectMcpServerDefinition: Tool = {
  type: "function",
  function: {
    name: "connectMcpServer",
    description:
      "Connect to a specific MCP server on-demand. This is useful for servers configured with autoConnect: false, or to reconnect a disconnected server. Once connected, the server's tools will be available for use.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        serverName: {
          type: "string",
          description: "The name of the MCP server to connect to",
        },
        timeout: {
          type: "number",
          description:
            "Connection timeout in milliseconds (optional, default: 30000)",
        },
      },
      required: ["serverName"],
    },
  },
};

const disconnectMcpServerDefinition: Tool = {
  type: "function",
  function: {
    name: "disconnectMcpServer",
    description:
      "Disconnect from a specific MCP server. This will close the connection and remove the server's tools from the available tools list.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        serverName: {
          type: "string",
          description: "The name of the MCP server to disconnect from",
        },
      },
      required: ["serverName"],
    },
  },
};

export const definitions = [
  listAvailableMcpServersDefinition,
  connectMcpServerDefinition,
  disconnectMcpServerDefinition,
];
