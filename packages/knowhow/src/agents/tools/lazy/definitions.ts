import { Tool } from "../../../clients/types";

export const listAvailableToolsDefinition: Tool = {
  type: "function",
  function: {
    name: "listAvailableTools",
    description:
      "List all available tools in the system, showing which are currently enabled and disabled. Use this to discover what tools exist before enabling them.",
    parameters: {
      type: "object",
      positional: true,
      properties: {},
      required: [],
    },
  },
};

export const enableToolsDefinition: Tool = {
  type: "function",
  function: {
    name: "enableTools",
    description:
      "Enable tools matching glob patterns. Examples: ['read*'] enables all tools starting with 'read', ['mcp_*_browser_*'] enables all browser MCP tools, ['*File'] enables all tools ending with 'File'. Pass an array of pattern strings.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of glob patterns to match tool names.",
        },
      },
      required: ["patterns"],
    },
  },
};

export const disableToolsDefinition: Tool = {
  type: "function",
  function: {
    name: "disableTools",
    description:
      "Disable tools matching glob patterns. This removes tools from the available tool list to stay within provider limits. Pass an array of pattern strings.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description: "Array of glob patterns to match tool names for disabling.",
        },
      },
      required: ["patterns"],
    },
  },
};

export const definitions = [
  listAvailableToolsDefinition,
  enableToolsDefinition,
  disableToolsDefinition,
];
