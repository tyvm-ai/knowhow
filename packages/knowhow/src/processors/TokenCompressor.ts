import { Message, Tool } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";
import {
  JsonCompressor,
  JsonSchema,
  CompressionMetadata,
  JsonCompressorStorage,
} from "./JsonCompressor";

export interface KeyInfo {
  key: string;
  size: number;
  preview: string;
  tokens?: number;
  type?: string;
  depth?: number;
  childKeys?: string[];
  nextChunkKey?: string;
}

interface TokenCompressorStorage {
  [key: string]: string;
}

export class TokenCompressor implements JsonCompressorStorage {
  private storage: TokenCompressorStorage = {};
  private keyPrefix: string = "compressed_";
  private toolName: string = expandTokensDefinition.function.name;

  // Threshold for compression - if content exceeds this size, we compress it
  private compressionThreshold: number = 4000;
  private characterLimit: number = this.compressionThreshold * 4;

  // Largest size retrievable without re-compressing
  public maxTokens: number = this.compressionThreshold * 2;

  // JSON compression handler
  private jsonCompressor: JsonCompressor;

  constructor(toolsService?: ToolsService) {
    this.jsonCompressor = new JsonCompressor(
      this,
      this.compressionThreshold,
      this.maxTokens,
      this.toolName
    );
    this.registerTool(toolsService);
  }

  // Rough token estimation (4 chars per token average)
  public estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public setCompressionThreshold(threshold: number): void {
    this.compressionThreshold = threshold;
    this.characterLimit = threshold * 4; // Update character limit based on new threshold
    this.jsonCompressor.updateSettings(threshold, this.maxTokens);
  }

  // Internally adjust to ensure we can always retrieve data
  private setMaxTokens(maxTokens: number): void {
    if (maxTokens > this.maxTokens) {
      this.maxTokens = maxTokens;
      this.jsonCompressor.updateSettings(this.compressionThreshold, maxTokens);
    }
  }

  /**
   * Attempts to parse content as JSON and returns parsed object if successful.
   * Also handles MCP tool response format where actual data is in content[0].text
   */

  public tryParseJson(content: string): any | null {
    return this.jsonCompressor.tryParseJson(content);
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
   * Check if content is already compressed
   */
  private isAlreadyCompressed(content: string): boolean {
    // Check for compressed string markers
    if (content.includes("[COMPRESSED_STRING")) {
      return true;
    }
    
    // Check for compressed JSON structure with schema key
    const parsed = this.tryParseJson(content);
    if (parsed && parsed._schema_key && typeof parsed._schema_key === "string") {
      return true;
    }
    
    return false;
  }

  /**
   * Enhanced content compression that handles both JSON and string chunking
   */
  public compressContent(content: string, path: string = ""): string {
    // Check if already compressed - don't compress again
    if (this.isAlreadyCompressed(content)) {
      return content;
    }

    const tokens = this.estimateTokens(content);

    // For nested properties (path !== ""), use maxTokens to avoid recompressing stored data
    // For top-level content (path === ""), use compressionThreshold to determine compression
    const thresholdToUse =
      path === "" ? this.compressionThreshold : this.maxTokens;

    if (tokens <= thresholdToUse) {
      return content;
    }

    // Try to parse as JSON and generate schema
    const jsonObj = this.tryParseJson(content);
    if (jsonObj) {
      // For MCP format, work with the actual data
      const dataToCompress = jsonObj._mcp_format ? jsonObj.data : jsonObj;

      // Generate and store schema
      const schema = this.jsonCompressor.generateSchema(jsonObj);
      const schemaKey = this.generateKey();
      this.storeString(schemaKey, JSON.stringify(schema));

      // For JSON objects, compress individual properties
      // Use a non-empty path to ensure compression logic is applied
      const compressedObj = this.compressJsonProperties(
        dataToCompress,
        path || "data"
      );

      // If this was MCP format, wrap the result back
      const finalCompressedObj = jsonObj._mcp_format
        ? {
            _mcp_format: true,
            _raw_structure: jsonObj._raw_structure,
            _data: compressedObj,
          }
        : compressedObj;

      // Add schema reference to the compressed result
      const resultWithSchema =
        typeof finalCompressedObj === "object" &&
        !Array.isArray(finalCompressedObj)
          ? { ...finalCompressedObj, _schema_key: schemaKey }
          : { _schema_key: schemaKey, data: finalCompressedObj };
      const compressedContent = JSON.stringify(resultWithSchema, null, 2);

      // Check compression effectiveness
      const compressedTokens = this.estimateTokens(compressedContent);

      // For MCP format, we've successfully extracted and compressed the data
      // The wrapper overhead is acceptable because we provide schema + structured access
      // For non-MCP format, use the standard 60% threshold
      const compressionThreshold = 0.6;

      if (compressedTokens < tokens * compressionThreshold) {
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
    return this.jsonCompressor.compressJsonProperties(obj, path);
  }

  public generateKey(): string {
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
    this.jsonCompressor.clearDeduplication();
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

  /**
   * Get the schema for a compressed object
   */
  getSchema(key: string): JsonSchema | null {
    const schemaKey = `${key}_schema`;
    const schemaStr = this.storage[schemaKey];
    if (!schemaStr) {
      return null;
    }
    try {
      return JSON.parse(schemaStr);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get compressed properties for an object
   */
  getCompressedProperties(key: string): any | null {
    const content = this.storage[key];
    if (!content) {
      return null;
    }
    try {
      const metadata = JSON.parse(content) as CompressionMetadata;
      return metadata.compressed_properties || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get full object by merging high-signal and compressed properties
   */
  getFullObject(mainObj: any, compressedKey: string): any {
    if (!mainObj || typeof mainObj !== "object") {
      return mainObj;
    }

    const compressed = this.getCompressedProperties(compressedKey);
    if (!compressed) {
      return mainObj;
    }

    const {
      _compressed_properties_key,
      _compressed_property_names,
      _compression_info,
      ...highSignal
    } = mainObj;
    return { ...highSignal, ...compressed };
  }

  /**
   * Extract all keys from compressed content
   */
  extractKeys(content: string): string[] {
    const keys: string[] = [];
    const keyPattern = /\$expandTokens\[([^\]]+)\]|Key:\s*([^\s\n]+)/g;
    let match;
    while ((match = keyPattern.exec(content)) !== null) {
      const key = match[1] || match[2];
      if (key && !keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Get the chain of keys for a given key (following NEXT_CHUNK_KEY references)
   */
  getKeyChain(key: string): KeyInfo[] {
    const chain: KeyInfo[] = [];
    let currentKey: string | null = key;

    while (currentKey) {
      const content = this.storage[currentKey];
      if (!content) break;

      chain.push({
        key: currentKey,
        size: content.length,
        preview: content.substring(0, 100),
      });

      const nextMatch = content.match(/NEXT_CHUNK_KEY:\s*([^\s\n]+)/);
      currentKey = nextMatch ? nextMatch[1] : null;
    }
    return chain;
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
