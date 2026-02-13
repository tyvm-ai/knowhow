import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";
import { JsonCompressor } from "./JsonCompressor";
import {
  jqToolResponseDefinition,
  executeJqQuery,
  grepToolResponseDefinition,
  executeGrep,
  GrepOptions,
  tailToolResponseDefinition,
  executeTail,
  TailOptions,
  listStoredToolResponsesDefinition,
  executeListStoredToolResponses,
} from "./tools";

interface ToolResponseStorage {
  [toolCallId: string]: string;
}

interface ToolResponseMetadata {
  toolCallId: string;
  originalLength: number;
  storedAt: number;
}

interface ToolResponseMetadataStorage {
  [toolCallId: string]: ToolResponseMetadata;
}

export class ToolResponseCache {
  private storage: ToolResponseStorage = {};
  private metadataStorage: ToolResponseMetadataStorage = {};
  private toolNameMap: { [toolCallId: string]: string } = {};
  private jsonCompressor: JsonCompressor;

  constructor(toolsService: ToolsService, jsonCompressor?: JsonCompressor) {
    // Use provided JsonCompressor or create a minimal storage adapter
    this.jsonCompressor = jsonCompressor || this.createMinimalJsonCompressor();
    this.registerTool(toolsService);
  }

  /**
   * Creates a minimal JsonCompressor instance for JSON parsing utilities
   * This is used when no JsonCompressor is provided to the constructor
   */
  private createMinimalJsonCompressor(): JsonCompressor {
    // Create a minimal storage adapter that satisfies JsonCompressorStorage interface
    const minimalStorage = {
      storeString: (key: string, value: string) => {
        // No-op for ToolResponseCache's internal use
      },
      generateKey: () => {
        return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      },
      estimateTokens: (text: string) => {
        return Math.ceil(text.length / 4);
      },
    };

    // Return a JsonCompressor instance with minimal settings
    return new JsonCompressor(minimalStorage, 4000, 8000, "expandTokens");
  }

  /**
   * Recursively searches for JSON strings within an object and parses them
   */
  public parseNestedJsonStrings(obj: any): any {
    if (typeof obj === "string") {
      const parsed = this.jsonCompressor.tryParseJson(obj);
      if (parsed) {
        return this.parseNestedJsonStrings(parsed);
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.parseNestedJsonStrings(item));
    }

    if (obj && typeof obj === "object") {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.parseNestedJsonStrings(value);
      }
      return result;
    }

    return obj;
  }

  /**
   * Stores a tool response for later manipulation
   */
  public storeToolResponse(
    content: string,
    toolCallId: string,
    toolName?: string
  ): void {
    // Only store if not already stored - prevents overwriting with compressed data
    // The first time we see a tool response, it contains the original uncompressed content
    // On subsequent passes (after compression), we don't want to overwrite with compressed data
    if (this.storage[toolCallId]) {
      return;
    }

    // Try to parse the content
    const parsed = this.jsonCompressor.tryParseJson(content);

    if (parsed && typeof parsed === 'object' && parsed._mcp_format === true && parsed._data) {
      // For MCP format responses, store the data in a normalized structure
      // This allows JQ queries to work directly against the data array
      // Store as JSON string to maintain compatibility with existing query methods
      this.storage[toolCallId] = JSON.stringify({
        _mcp_format: true,
        _raw_structure: parsed._raw_structure,
        _data: parsed._data
      });
    } else if (parsed !== null) {
      // Check if content is double-encoded by trying to parse again
      // Only re-stringify if we detected and handled double-encoding
      try {
        const outerParse = JSON.parse(content);
        if (typeof outerParse === 'string') {
          // This is double-encoded JSON, store the fully parsed result
          if (typeof parsed === 'object') {
            this.storage[toolCallId] = JSON.stringify(parsed);
          } else if (typeof parsed === 'string') {
            // Parsed to a string, store it as-is
            this.storage[toolCallId] = parsed;
          } else {
            // Store the original if we couldn't parse further
            this.storage[toolCallId] = content;
          }
        } else {
          // Not double-encoded, store original to preserve formatting
          this.storage[toolCallId] = content;
        }
      } catch {
        // Not valid JSON, store as-is
        this.storage[toolCallId] = content;
      }
    } else {
      // Could not parse as JSON, store as-is
      this.storage[toolCallId] = content;
    }

    // Store metadata for reference
    this.metadataStorage[toolCallId] = {
      toolCallId,
      originalLength: content.length,
      storedAt: Date.now(),
    };

    if (toolName) {
      this.toolNameMap[toolCallId] = toolName;
    }
  }

  /**
   * Processes messages to store tool responses silently
   */
  private async processMessage(message: Message): Promise<void> {
    // Only process tool response messages
    if (
      message.role !== "tool" ||
      !message.tool_call_id ||
      typeof message.content !== "string"
    ) {
      return;
    }

    // Store the tool response silently without modifying the message
    this.storeToolResponse(message.content, message.tool_call_id, message.name);
  }

  /**
   * Creates a message processor function that stores tool responses silently
   */
  createProcessor(
    filterFn?: (msg: Message) => boolean
  ): MessageProcessorFunction {
    return async (originalMessages: Message[], modifiedMessages: Message[]) => {
      for (const message of originalMessages) {
        if (filterFn && !filterFn(message)) {
          continue;
        }
        await this.processMessage(message);
      }
    };
  }

  /**
   * Retrieves and processes tool response data with JQ query
   */
  async queryToolResponse(
    toolCallId: string,
    jqQuery: string
  ): Promise<string> {
    const data = this.storage[toolCallId];
    const availableIds = Object.keys(this.storage);
    return executeJqQuery(data, toolCallId, jqQuery, availableIds);
  }

  /**
   * Grep through tool response data to find matching lines
   */
  async grepToolResponse(
    toolCallId: string,
    pattern: string,
    options?: GrepOptions
  ): Promise<string> {
    const data = this.storage[toolCallId];
    const availableIds = Object.keys(this.storage);
    return executeGrep(data, toolCallId, pattern, availableIds, options);
  }

  /**
   * Get the last n lines from a tool response
   */
  async tailToolResponse(
    toolCallId: string,
    options?: TailOptions
  ): Promise<string> {
    const data = this.storage[toolCallId];
    const availableIds = Object.keys(this.storage);
    return executeTail(data, toolCallId, availableIds, options);
  }

  /**
   * List all stored tool responses with metadata
   */
  async listStoredToolResponses(): Promise<string> {
    return executeListStoredToolResponses(
      this.storage,
      this.metadataStorage,
      this.toolNameMap
    );
  }

  /**
   * Retrieves the raw tool response data
   */
  retrieveRawResponse(toolCallId: string): string | null {
    return this.storage[toolCallId] || null;
  }

  /**
   * Clears all stored tool responses
   */
  clearStorage(): void {
    this.storage = {};
    this.metadataStorage = {};
  }

  /**
   * Gets all stored tool call IDs
   */
  getStorageKeys(): string[] {
    return Object.keys(this.storage);
  }

  /**
   * Gets the number of stored tool responses
   */
  getStorageSize(): number {
    return Object.keys(this.storage).length;
  }

  /**
   * Registers the jqToolResponse tool with the ToolsService
   */
  registerTool(toolsService: ToolsService): void {
    toolsService.addTools([
      jqToolResponseDefinition,
      grepToolResponseDefinition,
      tailToolResponseDefinition,
      listStoredToolResponsesDefinition,
    ]);
    toolsService.addFunctions({
      [jqToolResponseDefinition.function.name]: async (
        toolCallId: string,
        jqQuery: string
      ) => {
        return await this.queryToolResponse(toolCallId, jqQuery);
      },
      [grepToolResponseDefinition.function.name]: async (
        toolCallId: string,
        pattern: string,
        options?: any
      ) => {
        return await this.grepToolResponse(toolCallId, pattern, options);
      },
      [tailToolResponseDefinition.function.name]: async (
        toolCallId: string,
        options?: any
      ) => {
        return await this.tailToolResponse(toolCallId, options);
      },
      [listStoredToolResponsesDefinition.function.name]: async () => {
        return await this.listStoredToolResponses();
      },
    });
  }
}

export {
  jqToolResponseDefinition,
  grepToolResponseDefinition,
  tailToolResponseDefinition,
  listStoredToolResponsesDefinition,
};
