export const executeScriptDefinition = {
  type: "function",
  function: {
    name: "executeScript",
    description:
      "Execute a TypeScript script in a secure sandbox with access to tools and AI clients. The script runs in an isolated environment with resource quotas and security controls. Top level async function must be awaited. ie await main()",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        script: {
          type: "string",
          description:
            "The TypeScript script to execute. Must be complete, valid TypeScript code. The script has access to `callTool(name, args)` and `llm(messages, options?)` functions.",
        },
        policy: {
          type: "object",
          description: "Execution policy and resource limits (optional)",
          properties: {
            maxExecutionTimeMs: {
              type: "number",
              description:
                "Maximum execution time in milliseconds (default: 30000)",
            },
            maxMemoryMB: {
              type: "number",
              description: "Maximum memory usage in MB (default: 128)",
            },
            maxToolCalls: {
              type: "number",
              description: "Maximum number of tool calls allowed (default: 20)",
            },
            maxTokens: {
              type: "number",
              description:
                "Maximum number of tokens for LLM calls (default: 50000)",
            },
            allowedTools: {
              type: "array",
              items: { type: "string" },
              description:
                "List of allowed tool names (empty = all tools allowed)",
            },
            deniedTools: {
              type: "array",
              items: { type: "string" },
              description: "List of denied tool names",
            },
            allowNetworkAccess: {
              type: "boolean",
              description: "Allow network-accessing tools (default: true)",
            },
            allowFileSystemAccess: {
              type: "boolean",
              description: "Allow filesystem-accessing tools (default: true)",
            },
          },
        },
        context: {
          type: "object",
          description: "Additional context to pass to the script (optional)",
          properties: {
            variables: {
              type: "object",
              description: "Variables to make available in the script scope",
            },
            artifactDir: {
              type: "string",
              description:
                "Directory for saving artifacts (default: './artifacts')",
            },
          },
        },
      },
      required: ["script"],
    },
  },
};
