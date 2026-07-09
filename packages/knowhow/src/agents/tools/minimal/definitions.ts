import { Tool } from "../../../clients/types";

export const callToolDefinition: Tool = {
  type: "function",
  function: {
    name: "callTool",
    description:
      "Call any available tool by name with the given arguments. Use listStoredToolResponses + inspectTools to discover available tools and their argument schemas before calling. This is the primary way to call tools that are not in the base tool set.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        name: {
          type: "string",
          description: "The name of the tool to call.",
        },
        args: {
          type: "object",
          description:
            "The arguments to pass to the tool. Should match the tool's parameter schema.",
        },
      },
      required: ["name", "args"],
    },
  },
};

export const inspectToolsDefinition: Tool = {
  type: "function",
  function: {
    name: "inspectTools",
    description:
      "Get the full schema/definition for tools matching the given glob patterns. Use this to discover what arguments a tool needs before calling it via callTool. Example patterns: ['read*'] finds tools starting with 'read', ['*File'] finds tools ending with 'File'.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of glob patterns to filter tool names. If omitted, returns all available tools.",
        },
      },
      required: [],
    },
  },
};

export const minimalDefinitions = [callToolDefinition, inspectToolsDefinition];
