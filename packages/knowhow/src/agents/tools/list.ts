import { Tool } from "../../clients/types";
import { ChatCompletionTool } from "openai/resources/chat";

import { services } from "../../services";
import * as github from "./github/definitions";
import * as asana from "./asana/definitions";
import * as ycmd from "./ycmd/definitions";
import * as language from "./language/definitions";
import { googleSearchDefinition } from "./googleSearch";
import { executeScriptDefinition } from "./executeScript/definition";
import { startAgentTaskDefinition } from "./startAgentTask";

function getPluginNames(): string {
  try {
    const { Plugins } = services();
    return Plugins.listPlugins().join(", ");
  } catch {
    return "";
  }
}

export const includedTools = [
  {
    type: "function",
    function: {
      name: "embeddingSearch",
      description:
        "Fuzzy search with cosine similarity for files related to the user's goal. Uses embeddings. Use textSearch for exact matches. Use fileSearch for file paths.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          keyword: {
            type: "string",
            description:
              "The code, keyword or phrase to search for via embedding search",
          },
        },
        required: ["keyword"],
      },
      returns: {
        type: "string",
        description: "A string containing a JSON of all the matched files",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execCommand",
      description:
        "Execute a command in the system's command line interface. Use this to run tests and things in the terminal. Supports timeout functionality.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          command: {
            type: "string",
            description: "The command to execute",
          },
          timeout: {
            type: "number",
            description:
              "Timeout in milliseconds (optional). If not provided, defaults to 5000ms.",
          },
          continueInBackground: {
            type: "boolean",
            description:
              "Whether to let command continue in background on timeout (default: false). If false, command is killed on timeout.",
          },
          waitForCompletion: {
            type: "boolean",
            description:
              "Whether to wait for full completion regardless of timeout (default: false). When true, overrides timeout behavior.",
          },
        },
        required: ["command"],
      },
      returns: {
        type: "string",
        description:
          "The result of the command execution, including any output and errors. May include timeout status information.",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalAnswer",
      description:
        "Finalize the AI's task and return the answer to the user. You are required to call this at the end to send the response to the user",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          answer: {
            type: "string",
            description:
              "The AI's answer to be displayed to the user as the full explanation of the task and what was done",
          },
        },
        required: ["answer"],
      },
      returns: {
        type: "string",
        description:
          "The final answer string that will be displayed to the user",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "callPlugin",
      description: `Call a specified plugin with given input. Plugins provide additional context from supported URLs or words. This is a read-only operation. Currently available plugins: ${getPluginNames()}`,
      parameters: {
        type: "object",
        positional: true,
        properties: {
          pluginName: {
            type: "string",
            description: "The name of the plugin to be called",
          },
          userInput: {
            type: "string",
            description: "The input to pass to the plugin",
          },
        },
        required: ["pluginName", "userInput"],
      },
      returns: {
        type: "string",
        description: "The result of the plugin call",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "visionTool",
      description: "Ask the vision API a question about an image url",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          imageUrl: {
            type: "string",
            description: "The url of the image to load",
          },
          question: {
            type: "string",
            description: "The prompt related to the image",
          },
          provider: {
            type: "string",
            description: "The AI provider to use (default: 'openai')",
            default: "openai",
          },
          model: {
            type: "string",
            description: "The model to use (default: 'gpt-4o')",
            default: "gpt-4o",
          },
        },
        required: ["imageUrl", "question"],
      },
      returns: {
        type: "string",
        description:
          "The results of the vision API call as an answer to the prompt question",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readFile",
      description:
        "Read the contents of a file and return them as an array of blocks",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          filePath: {
            type: "string",
            description: "The path to the file to be read",
          },
        },
        required: ["filePath"],
      },
      returns: {
        type: "string",
        description: "The file contents in diff format",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readBlocks",
      description:
        "Read specific blocks from a file based on block numbers. Blocks are numbered blocks of text, containing a few lines of content ~500 characters",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          filePath: {
            type: "string",
            description:
              "The path to the file from which blocks are to be read",
          },
          blockNumbers: {
            type: "array",
            items: {
              type: "number",
            },
            description: "An array of block numbers to be read from the file",
          },
        },
        required: ["filePath", "blockNumbers"],
      },
      returns: {
        type: "array",
        description:
          "An array of file blocks corresponding to the specified block numbers",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patchFile",
      description:
        "Modify file with patch. Can also create new files. Use GNU diffutils syntax with - in front of removals and + in front of additions. Always check your work after applying a patch to ensure the patch did what you expected. Think step by step while constructing the patch, of which lines your will add and remove. Make sure that your patch is maintaining proper syntax. Do not modify lines unrelated to the goal. Patches should contain 3 to 6 lines of context before and after changes. No omissions of lines for removals are allowed. Use multiple small patches over one large patch that affects multiple places in the file.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          filePath: {
            type: "string",
            description: "The path to the file to be patched",
          },
          patch: {
            type: "string",
            description: "The patch to apply in unified diff format",
          },
        },
        required: ["filePath", "patch"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "lintFile",
      description:
        "Lint a file based on the file extension using predefined linting commands from the configuration.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          filePath: {
            type: "string",
            description: "The path to the file to be linted.",
          },
        },
        required: ["filePath"],
      },
      returns: {
        type: "string",
        description:
          "The result of the linting process or an empty string if no lint command is configured for the file extension.",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "textSearch",
      description:
        "Exact Search. Search for exact matches of text across files. Use embeddingSearch for fuzzy search. Use fileSearch for file paths",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          searchTerm: {
            type: "string",
            description: "The text string to search for across files",
          },
        },
        required: ["searchTerm"],
      },
      returns: {
        type: "string",
        description: "The result of the text search, including any matches",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fileSearch",
      description: "Search for files where the filepath includes a searchTerm",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          searchTerm: {
            type: "string",
            description: "a string to search for in file paths",
          },
        },
        required: ["searchTerm"],
      },
      returns: {
        type: "string",
        description: "The result of the file search, including any matches",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "askHuman",
      description: "Ask a human a question and get a response.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          question: {
            type: "string",
            description: "The question to ask the human. Can be in markdown",
          },
        },
        required: ["question"],
      },
      returns: {
        type: "string",
        description: "The response from the human.",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "writeFileChunk",
      description:
        "Update or create files by writing in small chunks of text. Suitable for larger files, this tool allows incremental writing by calling it multiple times.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          filePath: {
            type: "string",
            description:
              "The path to the file where the content will be written",
          },
          content: {
            type: "string",
            description: "The chunk of content to write to the file",
          },
          isContinuing: {
            type: "boolean",
            description:
              "Flag indicating whether to append the content to an existing file (`true`) or start a new file (`false`)",
          },
          isDone: {
            type: "boolean",
            description:
              "Flag indicating whether this is the final chunk of content",
          },
        },
        required: ["filePath", "content", "isContinuing", "isDone"],
      },
      returns: {
        type: "string",
        description:
          "A message indicating the status of the file writing process",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "createAiCompletion",
      description: "Create a completion using the knowhow AI client",
      parameters: {
        type: "object",
        additionalProperties: false,
        $defs: {
          message: {
            type: "object",
            additionalProperties: false,
            properties: {
              role: {
                type: "string",
                enum: ["system", "user", "assistant", "tool"],
              },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          toolLite: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["function"] },
              function: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  parameters: { type: "object" },
                },
                required: ["name", "parameters"],
              },
            },
            required: ["type", "function"],
          },
        },
        properties: {
          provider: {
            type: "string",
            description:
              "The AI provider to use (e.g., 'openai', 'anthropic'). Use listAllModels to discover providers.",
          },
          options: {
            type: "object",
            additionalProperties: false,
            description: "Provider-specific completion options",
            properties: {
              model: { type: "string", description: "The model to use" },
              messages: {
                type: "array",
                description: "The chat history for the completion",
                items: { $ref: "#/$defs/message" },
                minItems: 1,
              },
              max_tokens: {
                type: "number",
                description: "Maximum number of tokens to generate",
              },
              tools: {
                type: "array",
                description:
                  "Tool definitions the model may call (non-recursive subset)",
                items: { $ref: "#/$defs/toolLite" },
              },
            },
            required: ["model", "messages"],
          },
        },
        required: ["provider"],
      },
      returns: {
        type: "object",
        description: "The completion response from the AI provider",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listAllCompletionModels",
      description:
        "List all available completion models using the knowhow ai client",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      returns: {
        type: "object",
        description:
          "A dictionary of all available completion models for each provider",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "listAllEmbeddingModels",
      description:
        "List all available embedding models using the knowhow ai client",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      returns: {
        type: "object",
        description:
          "A dictionary of all available embedding models for each provider",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "listAllModels",
      description: "List all available models using the knowhow ai client",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      returns: {
        type: "object",
        description: "A dictionary of all available models for each provider",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "listAllProviders",
      description: "List all available providers using the knowhow ai client",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      returns: {
        type: "array",
        description: "An array of all available providers",
      },
    },
  },

  {
    type: "function",
    function: {
      name: "createEmbedding",
      description: "Create an embedding using the knowhow ai client",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          provider: {
            type: "string",
            description:
              "The AI provider to use (e.g., 'openai', 'anthropic'). Use listAllModels to figure out which provider to use if you don't know",
          },
          options: {
            type: "object",
            description: "The embedding options",
            properties: {
              input: { type: "string", description: "The text to embed" },
              model: {
                type: "string",
                description: "The model to use (optional)",
              },
            },
            required: ["input"],
          },
        },
        required: ["provider", "options"],
      },
      returns: {
        type: "object",
        description: "The embedding response from the AI provider",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "loadWebpage",
      description:
        "Load a webpage using a stealth browser to avoid bot detection. Can return either text content with console logs or a screenshot.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          url: {
            type: "string",
            description: "The URL of the webpage to load",
          },
          mode: {
            type: "string",
            description:
              "The mode for content extraction: 'text' for text content with console logs, 'screenshot' for a base64 encoded screenshot",
            enum: ["text", "screenshot"],
          },
          waitForSelector: {
            type: "string",
            description:
              "Optional CSS selector to wait for before extracting content",
          },
          timeout: {
            type: "number",
            description:
              "Timeout in milliseconds for page loading (default: 30000)",
          },
        },
        required: ["url"],
      },
      returns: {
        type: "string",
        description:
          "The webpage content as text with console logs, or a base64 encoded screenshot",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stringReplace",
      description:
        "Replace exact string matches in multiple files. Performs global replacement of all occurrences of the find string with the replace string.",
      parameters: {
        type: "object",
        positional: true,
        properties: {
          findString: {
            type: "string",
            description: "The exact string to find and replace",
          },
          replaceString: {
            type: "string",
            description: "The string to replace the found string with",
          },
          filePaths: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Array of file paths where the replacement should be performed",
          },
        },
        required: ["findString", "replaceString", "filePaths"],
      },
      returns: {
        type: "string",
        description: "A summary of the replacement results for each file",
      },
    },
  },
  executeScriptDefinition,
  googleSearchDefinition,
  startAgentTaskDefinition,
  {
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
      returns: {
        type: "string",
        description:
          "JSON object containing all available AST paths in the file",
      },
    },
  },
  {
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
      returns: {
        type: "string",
        description: "JSON object with edit result and updated file content",
      },
    },
  },
  {
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
      returns: {
        type: "string",
        description: "JSON object with append result and updated file content",
      },
    },
  },
  {
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
      returns: {
        type: "string",
        description: "JSON object with delete result and updated file content",
      },
    },
  },
  {
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
      returns: {
        type: "string",
        description:
          "JSON object containing AST paths and locations for the matching text",
      },
    },
  },
  ...asana.definitions,
  ...ycmd.definitions,
  ...github.definitions,
  ...language.definitions,
] as Tool[];
