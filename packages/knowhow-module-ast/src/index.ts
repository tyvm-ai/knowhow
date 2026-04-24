import { KnowhowModule, ModuleTool, InitParams } from "@tyvm/knowhow/ts_build/src/services/modules/types";

// Import tool handlers
import { astListPaths } from "./tools/astListPaths";
import { astEditNode } from "./tools/astEditNode";
import { astAppendNode } from "./tools/astAppendNode";
import { astDeleteNode } from "./tools/astDeleteNode";
import { astGetPathForLine } from "./tools/astGetPathForLine";

// Tool definitions (copied from packages/knowhow/src/agents/tools/list.ts)
const tools: ModuleTool[] = [
  {
    name: "astListPaths",
    handler: astListPaths,
    definition: {
      type: "function",
      function: {
        name: "astListPaths",
        description:
          "List all available simple paths in a file using tree-sitter AST parsing. Useful for understanding the structure of a file before making targeted edits.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            filePath: {
              type: "string",
              description: "The path to the file to analyze",
            },
          },
          required: ["filePath"],
        },
      },
    },
  },
  {
    name: "astEditNode",
    handler: astEditNode,
    definition: {
      type: "function",
      function: {
        name: "astEditNode",
        description:
          "Update a node at a specific AST path in a file using tree-sitter parsing. Use astListPaths first to find available paths.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            filePath: {
              type: "string",
              description: "The path to the file to edit",
            },
            path: {
              type: "string",
              description:
                "The AST path to the node to update (from astListPaths)",
            },
            newContent: {
              type: "string",
              description: "The new content to replace the node with",
            },
          },
          required: ["filePath", "path", "newContent"],
        },
      },
    },
  },
  {
    name: "astAppendNode",
    handler: astAppendNode,
    definition: {
      type: "function",
      function: {
        name: "astAppendNode",
        description:
          "Append a child node to a specific AST path in a file using tree-sitter parsing. Use astListPaths first to find available paths.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            filePath: {
              type: "string",
              description: "The path to the file to edit",
            },
            parentPath: {
              type: "string",
              description: "The AST path to the parent node (from astListPaths)",
            },
            newContent: {
              type: "string",
              description: "The content of the child node to append",
            },
          },
          required: ["filePath", "parentPath", "newContent"],
        },
      },
    },
  },
  {
    name: "astDeleteNode",
    handler: astDeleteNode,
    definition: {
      type: "function",
      function: {
        name: "astDeleteNode",
        description:
          "Delete a node at a specific AST path in a file using tree-sitter parsing. Use astListPaths first to find available paths.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            filePath: {
              type: "string",
              description: "The path to the file to edit",
            },
            path: {
              type: "string",
              description:
                "The AST path to the node to delete (from astListPaths)",
            },
          },
          required: ["filePath", "path"],
        },
      },
    },
  },
  {
    name: "astGetPathForLine",
    handler: astGetPathForLine,
    definition: {
      type: "function",
      function: {
        name: "astGetPathForLine",
        description:
          "Get the AST path for a specific line of text in a file using tree-sitter parsing. Useful for finding the structural location of specific code.",
        parameters: {
          type: "object",
          positional: true,
          properties: {
            filePath: {
              type: "string",
              description: "The path to the file to analyze",
            },
            searchText: {
              type: "string",
              description: "The text to search for in the file",
            },
          },
          required: ["filePath", "searchText"],
        },
      },
    },
  },
];

const astModule: KnowhowModule = {
  async init(params: InitParams) {},
  tools,
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default astModule;
export * from "./parser";
export * from "./editor";
export * from "./simple-paths";
