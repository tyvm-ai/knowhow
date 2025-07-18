import { Message, Tool } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";

interface TokenCompressorStorage {
  [key: string]: string;
}

export class TokenCompressor {
  private storage: TokenCompressorStorage = {};
  private maxTokens: number = 4000;
  private compressionRatio: number = 0.1;
  private keyPrefix: string = "compressed_";
  private toolName: string = expandTokensDefinition.function.name;
  private characterLimit: number = this.maxTokens * 4;
  private jsonPropertyThreshold: number = this.maxTokens;

  constructor(toolsService?: ToolsService) {
    this.registerTool(toolsService);
  }

  // Rough token estimation (4 chars per token average)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
    this.characterLimit = maxTokens * 4;
    this.jsonPropertyThreshold = maxTokens;
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
   * Compresses a string into chunks from the end, creating a chain of references
   */
  public compressStringInChunks(content: string, path: string = ""): string {
    if (content.length <= this.characterLimit) {
      return content;
    }

    const chunks: string[] = [];
    const chunkKeys: string[] = [];
    let remaining = content;

    // Split from the end, creating chunks that will be linked
    while (remaining.length > this.characterLimit) {
      const chunkStart = remaining.length - this.characterLimit;
      const chunk = remaining.substring(chunkStart);
      chunks.unshift(chunk); // Add to beginning since we're working backwards
      remaining = remaining.substring(0, chunkStart);
    }

    // The remaining part becomes the first chunk
    if (remaining.length > 0) {
      chunks.unshift(remaining);
    }

    // Store chunks and create chain of references
    for (let i = chunks.length - 1; i >= 0; i--) {
      const key = this.generateKey();
      chunkKeys.unshift(key);

      let chunkContent = chunks[i];

      // Add reference to next chunk if it exists
      if (i < chunks.length - 1) {
        const nextKey = chunkKeys[i + 1];
        chunkContent += `\n\n[NEXT_CHUNK_KEY: ${nextKey}]`;
      }

      this.storage[key] = chunkContent;
    }

    // Return reference to the first chunk
    const firstKey = chunkKeys[0];
    const totalTokens = this.estimateTokens(content);
    const chunkCount = chunks.length;

    return `[COMPRESSED_STRING - ${totalTokens} tokens in ${chunkCount} chunks]\nKey: ${firstKey}\nPath: ${path}\nPreview: ${content.substring(
      0,
      200
    )}...\n[Use ${
      this.toolName
    } tool with key "${firstKey}" to retrieve content. Follow NEXT_CHUNK_KEY references for complete content]`;
  }

  /**
   * Enhanced content compression that handles both JSON and string chunking
   */
  public compressContent(content: string, path: string = ""): string {
    const tokens = this.estimateTokens(content);

    if (tokens <= this.maxTokens) {
      return content;
    }

    // Try to parse as JSON first
    const jsonObj = this.tryParseJson(content);
    if (jsonObj) {
      // For JSON objects, compress individual properties
      const compressedObj = this.compressJsonProperties(jsonObj, path);
      const compressedContent = JSON.stringify(compressedObj, null, 2);

      // If compression reduced size significantly, return compressed version
      const compressedTokens = this.estimateTokens(compressedContent);
      if (compressedTokens < tokens * 0.8) {
        return compressedContent;
      }
    }

    // For strings or when JSON compression wasn't effective, use chunking
    return this.compressStringInChunks(content, path);
  }

  /**
   * Compresses large properties within a JSON object using depth-first traversal.
   * Implements an efficient backward-iterating chunking strategy for large arrays.
   */
  public compressJsonProperties(obj: any, path: string = ""): any {
    if (Array.isArray(obj)) {
      // Step 1: Recursively compress all items first (depth-first).
      const processedItems = obj.map((item, index) =>
        this.compressJsonProperties(item, `${path}[${index}]`)
      );

      // Step 2: Early exit if the whole array is already small enough.
      // Leeway of 30% over, to avoid re-compression of retrievals
      const initialTokens = this.estimateTokens(JSON.stringify(processedItems));
      if (initialTokens <= this.jsonPropertyThreshold * 1.3) {
        return processedItems;
      }

      // Step 3: Iterate backwards, building chunks from the end.
      const finalArray: any[] = [];
      let currentChunk: any[] = [];

      for (let i = processedItems.length - 1; i >= 0; i--) {
        const item = processedItems[i];
        currentChunk.unshift(item); // Add item to the front of the current chunk

        const chunkString = JSON.stringify(currentChunk);
        const chunkTokens = this.estimateTokens(chunkString);

        if (chunkTokens > this.jsonPropertyThreshold) {
          const key = this.generateKey();
          this.storage[key] = chunkString;

          const stub = `[COMPRESSED_JSON_ARRAY_CHUNK - ${chunkTokens} tokens, ${
            currentChunk.length
          } items]\nKey: ${key}\nPath: ${path}[${i}...${
            i + currentChunk.length - 1
          }]\nPreview: ${chunkString.substring(0, 100)}...\n[Use ${
            this.toolName
          } tool with key "${key}" to retrieve this chunk]`;
          finalArray.unshift(stub); // Add stub to the start of our final result.

          currentChunk = [];
        }
      }

      // Step 4: After the loop, add any remaining items from the start of the
      // array that did not form a full chunk.
      if (currentChunk.length > 0) {
        finalArray.unshift(...currentChunk);
      }
      return finalArray;
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

        return `[COMPRESSED_JSON_OBJECT - ${tokens} tokens]\nKey: ${key}\nPath: ${path}\nKeys: ${Object.keys(
          result
        ).join(", ")}\nPreview: ${objectAsString.substring(0, 200)}...\n[Use ${
          this.toolName
        } tool with key "${key}" to retrieve full content]`;
      }
      return result;
    }

    // Handle primitive values (strings, numbers, booleans, null)
    if (typeof obj === "string") {
      // First, check if this string contains JSON that we can parse and compress more granularly
      const parsedJson = this.tryParseJson(obj);
      if (parsedJson) {
        const compressedJson = this.compressJsonProperties(parsedJson, path);
        const compressedJsonString = JSON.stringify(compressedJson, null, 2);

        const originalTokens = this.estimateTokens(obj);
        const compressedTokens = this.estimateTokens(compressedJsonString);

        if (compressedTokens < originalTokens * 0.8) {
          return compressedJsonString;
        }
      }

      // If not JSON or compression wasn't effective, handle as regular string
      const tokens = this.estimateTokens(obj);
      if (tokens > this.characterLimit * 4) {
        const key = this.generateKey();
        this.storage[key] = obj;

        return `[COMPRESSED_JSON_PROPERTY - ${tokens} tokens]\nKey: ${key}\nPath: ${path}\nPreview: ${obj.substring(
          0,
          200
        )}...\n[Use ${
          this.toolName
        } tool with key "${key}" to retrieve full content]`;
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

  public compressToolCall(message: Message): void {
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.arguments) {
          const args = toolCall.function.arguments;
          const tokens = this.estimateTokens(args);

          if (tokens > this.maxTokens) {
            const key = this.generateKey();
            this.storage[key] = args;

            const compressed = `[COMPRESSED TOOL ARGS - ${tokens} tokens]\nKey: ${key}\nPreview: ${args.substring(
              0,
              200
            )}...\n[Use ${
              this.toolName
            } tool with key "${key}" to retrieve full arguments]`;

            toolCall.function.arguments = compressed;
          }
        }
      }
    }
  }

  public async compressMessage(message: Message) {
    // The previous check for 'isDecompressionToolResponse' is no longer necessary.
    // The new chunking strategy returns manageable chunks that won't meet the
    // compression threshold, naturally preventing cycles.

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

  /**
   * Retrieves a single chunk of stored data.
   * If the data was chunked, the returned string will contain a `NEXT_CHUNK_KEY`
   * that the agent can use to retrieve the subsequent part of the content.
   */
  retrieveString(key: string): string | null {
    return this.storage[key] || null;
  }

  clearStorage(): void {
    this.storage = {};
  }

  getStorageKeys(): string[] {
    return Object.keys(this.storage);
  }

  getStorageSize(): number {
    return Object.keys(this.storage).length;
  }

  registerTool(toolsService?: ToolsService): void {
    if (toolsService && !toolsService.getTool(this.toolName)) {
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
      "Retrieve a chunk of compressed data that was stored during message processing. The returned content may contain a `NEXT_CHUNK_KEY` to retrieve subsequent chunks.",
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
