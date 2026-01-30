import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";
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

  constructor(toolsService: ToolsService) {
    this.registerTool(toolsService);
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
   * Recursively searches for JSON strings within an object and parses them
   */
  public parseNestedJsonStrings(obj: any): any {
    if (typeof obj === "string") {
      const parsed = this.tryParseJson(obj);
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

    // Store the original content for later JQ/grep manipulation
    this.storage[toolCallId] = content;

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
