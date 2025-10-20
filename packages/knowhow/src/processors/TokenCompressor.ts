import { Message, Tool } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";

interface TokenCompressorStorage {
  [key: string]: string;
}

export class TokenCompressor {
  private storage: TokenCompressorStorage = {};
  private keyPrefix: string = "compressed_";
  private toolName: string = expandTokensDefinition.function.name;

  // Threshold for compression - if content exceeds this size, we compress it
  private compressionThreshold: number = 4000;
  private characterLimit: number = this.compressionThreshold * 4;

  // Largest size retrievable without re-compressing
  private maxTokens: number = this.compressionThreshold * 2;

  constructor(toolsService?: ToolsService) {
    this.registerTool(toolsService);
  }

  // Rough token estimation (4 chars per token average)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public setCompressionThreshold(threshold: number): void {
    this.compressionThreshold = threshold;
    this.characterLimit = threshold * 4; // Update character limit based on new threshold
  }

  // Internally adjust to ensure we can always retrieve data
  private setMaxTokens(maxTokens: number): void {
    if (maxTokens > this.maxTokens) {
      this.maxTokens = maxTokens;
    }
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
    // First, generate all keys
    for (let i = 0; i < chunks.length; i++) {
      const key = this.generateKey();
      chunkKeys.push(key);
    }

    // Then store chunks with proper linking
    for (let i = 0; i < chunks.length; i++) {
      let chunkContent = chunks[i];

      // Add reference to next chunk if it exists
      if (i < chunks.length - 1) {
        const nextKey = chunkKeys[i + 1];
        chunkContent += `\n\n[NEXT_CHUNK_KEY: ${nextKey}]`;
      }

      this.storeString(chunkKeys[i], chunkContent);
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

    // For nested properties (path !== ""), use maxTokens to avoid recompressing stored data
    // For top-level content (path === ""), use compressionThreshold to determine compression
    const thresholdToUse =
      path === "" ? this.compressionThreshold : this.maxTokens;

    if (tokens <= thresholdToUse) {
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
    if (
      path === "" &&
      this.estimateTokens(JSON.stringify(obj)) <= this.maxTokens
    ) {
      return obj;
    }

    if (Array.isArray(obj)) {
      // Step 1: Recursively compress all items first (depth-first).
      const processedItems = obj.map((item, index) =>
        this.compressJsonProperties(item, `${path}[${index}]`)
      );

      // Step 2: Early exit if the whole array is already small enough.
      // maxTokens allows us to fetch objects from the store without recompressing

      // Step 3: Iterate backwards, building chunks from the end.
      const finalArray: any[] = [];
      let currentChunk: any[] = [];

      for (let i = processedItems.length - 1; i >= 0; i--) {
        const item = processedItems[i];
        currentChunk.unshift(item); // Add item to the front of the current chunk

        const chunkString = JSON.stringify(currentChunk);
        const chunkTokens = this.estimateTokens(chunkString);

        if (chunkTokens > this.compressionThreshold) {
          const key = this.generateKey();
          this.storeString(key, chunkString);

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
      if (tokens > this.compressionThreshold) {
        const key = this.generateKey();
        this.storeString(key, objectAsString);

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
      if (tokens > this.compressionThreshold) {
        const key = this.generateKey();
        this.storeString(key, obj);

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

  public async compressMessage(message: Message) {
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

  storeString(key: string, value: string): void {
    if (this.estimateTokens(value) > this.maxTokens) {
      // adjust max tokens so we can always retrieve this without re-compressing
      this.setMaxTokens(this.estimateTokens(value) + 1);
    }
    this.storage[key] = value;
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
    if (toolsService) {
      toolsService.addTools([expandTokensDefinition]);
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
