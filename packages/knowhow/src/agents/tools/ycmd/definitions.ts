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
      description: "Get code completions at a specific position in a file. You can specify the position either with line/column numbers OR with a searchString that will be located automatically.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based). Required if searchString is not provided.",
          },
          column: {
            type: "number",
            description: "Column number (1-based). Required if searchString is not provided.",
          },
          searchString: {
            type: "string",
            description: "String to search for in the file to determine completion position. Alternative to line/column. Completions will be provided after this string.",
          },
          matchType: {
            type: "string",
            description: "Type of matching when using searchString: 'exact' for exact match, 'prefix' for prefix matching, 'contains' for substring match",
            enum: ["exact", "prefix", "contains"],
          },
          forceSemantic: {
            type: "boolean",
            description: "Force semantic completions instead of identifier-based completions",
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
        },
        required: ["filepath"],
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
      description: "Navigate to definitions, declarations, or find references for a symbol. You can specify the position either with line/column numbers OR with a searchString that will be located automatically.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based). Required if searchString is not provided.",
          },
          column: {
            type: "number",
            description: "Column number (1-based). Required if searchString is not provided.",
          },
          searchString: {
            type: "string",
            description: "String to search for in the file to determine the symbol position. Alternative to line/column.",
          },
          matchType: {
            type: "string",
            description: "Type of matching when using searchString: 'exact' for exact match, 'prefix' for prefix matching, 'contains' for substring match",
            enum: ["exact", "prefix", "contains"],
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
        required: ["filepath", "command"],
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
      description: "Get error and warning diagnostics for a file. You can specify the position either with line/column numbers OR with a searchString that will be located automatically.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          line: {
            type: "number",
            description: "Line number (1-based, optional, defaults to 1). Required if searchString is not provided.",
          },
          column: {
            type: "number", 
            description: "Column number (1-based, optional, defaults to 1). Required if searchString is not provided.",
          },
          searchString: {
            type: "string",
            description: "String to search for in the file to determine the diagnostic position. Alternative to line/column.",
          },
          matchType: {
            type: "string",
            description: "Type of matching when using searchString: 'exact' for exact match, 'prefix' for prefix matching, 'contains' for substring match",
            enum: ["exact", "prefix", "contains"],
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
  {
    type: "function",
    function: {
      name: "getLocations",
      description: "Find line and column positions for a given string in a file. Useful for locating code elements by name rather than coordinates.",
      parameters: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file. Can be relative (defaults to current working directory) or absolute",
          },
          searchString: {
            type: "string",
            description: "The string to search for in the file",
          },
          fileContents: {
            type: "string",
            description: "Current contents of the file (optional if file exists on disk)",
          },
          matchType: {
            type: "string",
            description: "Type of matching: 'exact' for exact string match, 'prefix' for prefix matching at word boundaries, 'contains' for case-insensitive substring match",
            enum: ["exact", "prefix", "contains"],
          },
          maxResults: {
            type: "number",
            description: "Maximum number of results to return (default: 50)",
          },
        },
        required: ["filepath", "searchString"],
      },
      returns: {
        type: "object",
        description: "Array of locations with line numbers, column numbers, and context information",
        properties: {
          success: { type: "boolean" },
          locations: { type: "array" },
          message: { type: "string" }
        }
      },
    },
  },
];