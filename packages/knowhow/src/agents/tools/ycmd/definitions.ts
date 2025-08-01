export const definitions = [
  {
    type: "function",
    function: {
      name: "ycmdStart",
      description: "Start ycmd server with project configuration for code intelligence features",
      parameters: {
        type: "object",
        properties: {
          workspaceRoot: {
            type: "string",
            description: "Path to the project root directory. Defaults to current working directory and auto-detects TypeScript/Node.js projects via tsconfig.json or package.json",
          },
          config: {
            type: "object",
            description: "Optional ycmd server configuration",
            properties: {
              port: {
                type: "number",
                description: "Port for ycmd server (0 for auto-assign)",
              },
              logLevel: {
                type: "string",
                description: "Log level: debug, info, warning, error",
              },
              completionTimeout: {
                type: "number",
                description: "Completion timeout in milliseconds",
              },
            },
          },
        },
        required: [],
      },
      returns: {
        type: "object",
        description: "Server information including host, port, and status",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycmdCompletion",
      description: "Get code completions at a specific position in a file",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based)",
          },
          column: {
            type: "number",
            description: "Column number (1-based)",
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
        },
        required: ["filepath", "line", "column"],
      },
      returns: {
        type: "object",
        description: "Completion results with suggestions and metadata",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycmdGoTo",
      description: "Navigate to definitions, declarations, or find references for a symbol",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based)",
          },
          column: {
            type: "number",
            description: "Column number (1-based)",
          },
          command: {
            type: "string",
            description: "Navigation command: GoToDefinition, GoToDeclaration, GoToReferences, GoToImplementation",
            enum: ["GoToDefinition", "GoToDeclaration", "GoToReferences", "GoToImplementation"],
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
        },
        required: ["filepath", "line", "column", "command"],
      },
      returns: {
        type: "array",
        description: "Array of locations with file paths, line numbers, and column numbers",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycmdDiagnostics",
      description: "Get error and warning diagnostics for a file",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based, optional, defaults to 1)",
          },
          column: {
            type: "number", 
            description: "Column number (1-based, optional, defaults to 1)",
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
        },
        required: ["filepath"],
      },
      returns: {
        type: "array",
        description: "Array of diagnostic messages with severity, location, and description",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycmdRefactor",
      description: "Execute refactoring operations like rename, extract method, organize imports",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based)",
          },
          column: {
            type: "number",
            description: "Column number (1-based)",
          },
          command: {
            type: "string",
            description: "Refactoring command: RefactorRename, RefactorExtractMethod, RefactorOrganizeImports, RefactorFixIt",
            enum: ["RefactorRename", "RefactorExtractMethod", "RefactorOrganizeImports", "RefactorFixIt"],
          },
          newName: {
            type: "string",
            description: "New name for rename operations",
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
        },
        required: ["filepath", "line", "column", "command"],
      },
      returns: {
        type: "object",
        description: "Refactoring result with file changes and status",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ycmdSignatureHelp",
      description: "Get function signature help and parameter information at cursor position",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based)",
          },
          column: {
            type: "number",
            description: "Column number (1-based)",
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
        },
        required: ["filepath", "line", "column"],
      },
      returns: {
        type: "object",
        description: "Signature help with function signatures and parameter information",
      },
    },
  },
];