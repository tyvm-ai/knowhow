import { ask } from "../utils";
import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "src/services";
import { Tool } from "../clients";

interface JsonCompressionMetadata {
  originalKey: string;
  compressedProperties: string[];
  type: "json" | "string";
}

interface TokenCompressorStorage {
  [key: string]: string;
}

interface CompressionMetadataStorage {
  [key: string]: JsonCompressionMetadata;
}

export class TokenCompressor {
  private storage: TokenCompressorStorage = {};
  private metadataStorage: CompressionMetadataStorage = {};
  private maxTokens: number = 4000;
  private compressionRatio: number = 0.1;
  private keyPrefix: string = "compressed_";
  private jsonPropertyThreshold: number = 4000;
  private toolName: string = expandTokensDefinition.function.name;

  constructor(toolsService: ToolsService) {
    this.registerTool(toolsService);
  }

  // Rough token estimation (4 chars per token average)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Detects if a message is a tool response from expandTokens or similar decompression tools
   */
  private isDecompressionToolResponse(message: Message): boolean {
    // Check if it's a tool response message
    if (message.role !== "tool" || !message.tool_call_id) {
      return false;
    }

    // Check if the content contains a previously compressed key
    if (typeof message.content === "string") {
      const content = message.content;
      // Look for patterns that indicate this is decompressed content
      const hasCompressedKey = Object.keys(this.storage).some(
        (key) => content.includes(key) || content === this.storage[key]
      );

      const hasResponseFormat = content.includes(`${this.toolName}Resp:`);

      return hasCompressedKey || hasResponseFormat;
    }

    return false;
  }

  /**
   * Attempts to parse content as JSON and returns parsed object if successful
   */
  private tryParseJson(content: string): any | null {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Compresses large string properties within a JSON object using depth-first traversal
   */
  private compressJsonProperties(obj: any, path: string = ""): any {
    // Handle arrays - process all elements first (depth-first)
    if (Array.isArray(obj)) {
      const processedArray = obj.map((item, index) =>
        this.compressJsonProperties(item, `${path}[${index}]`)
      );

      // After processing children, check if the entire array should be compressed
      const arrayAsString = JSON.stringify(processedArray);
      const tokens = this.estimateTokens(arrayAsString);
      if (tokens > this.jsonPropertyThreshold) {
        const key = this.generateKey();
        this.storage[key] = arrayAsString;

        return `[COMPRESSED_JSON_ARRAY - ${tokens} tokens]
Key: ${key}
Path: ${path}
Length: ${processedArray.length} items
Preview: ${arrayAsString.substring(0, 200)}...
[Use ${this.toolName} tool with key "${key}" to retrieve full content]`;
      }
      return processedArray;
    }

    // Handle objects - process all properties first (depth-first)
    if (obj && typeof obj === "object") {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        const newPath = path ? `${path}.${key}` : key;
        result[key] = this.compressJsonProperties(value, newPath);
      }

      // After processing children, check if the entire object should be compressed
      const objectAsString = JSON.stringify(result);
      const tokens = this.estimateTokens(objectAsString);
      if (tokens > this.jsonPropertyThreshold) {
        const key = this.generateKey();
        this.storage[key] = objectAsString;

        return `[COMPRESSED_JSON_OBJECT - ${tokens} tokens]
Key: ${key}
Path: ${path}
Keys: ${Object.keys(result).join(", ")}
Preview: ${objectAsString.substring(0, 200)}...
[Use ${this.toolName} tool with key "${key}" to retrieve full content]`;
      }
      return result;
    }

    // Handle primitive values (strings, numbers, booleans, null)
    if (typeof obj === "string") {
      // First, check if this string contains JSON that we can parse and compress more granularly
      const parsedJson = this.tryParseJson(obj);
      if (parsedJson) {
        // Recursively compress the parsed JSON
        const compressedJson = this.compressJsonProperties(parsedJson, path);
        const compressedJsonString = JSON.stringify(compressedJson, null, 2);

        // If the compressed JSON is significantly smaller, use it
        const originalTokens = this.estimateTokens(obj);
        const compressedTokens = this.estimateTokens(compressedJsonString);

        if (compressedTokens < originalTokens * 0.8) {
          return compressedJsonString;
        }
      }

      // If not JSON or compression wasn't effective, handle as regular string
      const tokens = this.estimateTokens(obj);
      if (tokens > this.jsonPropertyThreshold) {
        const key = this.generateKey();
        this.storage[key] = obj;

        return `[COMPRESSED_JSON_PROPERTY - ${tokens} tokens]\nKey: ${key}\nPath: ${path}\nPreview: ${obj.substring(
          0,
          200
        )}...
[Use ${this.toolName} tool with key "${key}" to retrieve full content]`;
      }
      return obj;
    }

    return obj;
  }

  private generateKey(): string {
    return `${this.keyPrefix}${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
  }

  private compressContent(content: string): string {
    const tokens = this.estimateTokens(content);

    if (tokens <= this.maxTokens) {
      return content;
    }

    // Try to parse as JSON first
    const jsonObj = this.tryParseJson(content);
    if (jsonObj) {
      // For JSON objects, compress individual properties
      const compressedObj = this.compressJsonProperties(jsonObj);
      const compressedContent = JSON.stringify(compressedObj, null, 2);

      // If compression reduced size significantly, return compressed version
      const compressedTokens = this.estimateTokens(compressedContent);
      if (compressedTokens < tokens * 0.8) {
        return compressedContent;
      }

      // Otherwise fall back to full content compression
    }

    // Store original content for non-JSON or when JSON compression wasn't effective
    const key = this.generateKey();
    this.storage[key] = content;

    // Store metadata about this compression
    this.metadataStorage[key] = {
      originalKey: key,
      compressedProperties: [],
      type: jsonObj ? "json" : "string",
    };

    // Create compressed summary
    const targetLength = Math.floor(content.length * this.compressionRatio);
    const beginning = content.substring(0, targetLength / 2);
    const end = content.substring(content.length - targetLength / 2);

    return `[COMPRESSED DATA - ${tokens} tokens compressed to ~${Math.ceil(
      targetLength / 4
    )} tokens]
Key: ${key}
Beginning: ${beginning}
...
End: ${end}
[Use ${this.toolName} tool with key "${key}" to retrieve full content]`;
  }

  private compressToolCall(message: Message): void {
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.arguments) {
          const args = toolCall.function.arguments;
          const tokens = this.estimateTokens(args);

          if (tokens > this.maxTokens) {
            const key = this.generateKey();
            this.storage[key] = args;

            const compressed = `[COMPRESSED TOOL ARGS - ${tokens} tokens]
Key: ${key}
Preview: ${args.substring(0, 200)}...
[Use ${this.toolName} tool with key "${key}" to retrieve full arguments]`;

            toolCall.function.arguments = compressed;
          }
        }
      }
    }
  }

  private async compressMessage(message: Message) {
    // We used to skip decompression messages
    // Compress content if it's a string
    if (typeof message.content === "string") {
      message.content = this.compressContent(message.content);
    }
    // Handle array content (multimodal)
    else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item.type === "text" && item.text) {
          item.text = this.compressContent(item.text);
        }
      }
    }

    // Compress tool calls
    this.compressToolCall(message);
  }

  createProcessor(
    filterFn?: (msg: Message) => boolean
  ): MessageProcessorFunction {
    return async (originalMessages: Message[], modifiedMessages: Message[]) => {
      for (const message of modifiedMessages) {
        if (filterFn && !filterFn(message)) {
          continue;
        }
        await this.compressMessage(message);
      }
    };
  }

  retrieveString(key: string): string | null {
    return this.storage[key] || null;
  }

  clearStorage(): void {
    this.storage = {};
    this.metadataStorage = {};
  }

  getStorageKeys(): string[] {
    return Object.keys(this.storage);
  }

  getStorageSize(): number {
    return Object.keys(this.storage).length;
  }

  registerTool(toolsService: ToolsService): void {
    if (!toolsService.getTool(this.toolName)) {
      toolsService.addTool(expandTokensDefinition);
      toolsService.addFunctions({
        [this.toolName]: (key: string) => {
          const data = this.retrieveString(key);

          if (!data) {
            return `Error: No data found for key "${key}". Available keys: ${this.getStorageKeys().join(
              ", "
            )}`;
          }
          return data;
        },
      });
    }
  }
}

export const expandTokensDefinition: Tool = {
  type: "function",
  function: {
    name: "expandTokens",
    description:
      "Retrieve compressed data that was stored during message processing. Use this when you see a compressed data key in messages.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        key: {
          type: "string",
          description: "The key of the compressed data to retrieve",
        },
      },
      required: ["key"],
    },
  },
};
