import { Message } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";
import { ToolsService } from "../services";
import { Tool } from "../clients";
import * as jq from "node-jq";

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
  private toolName: string = jqToolResponseDefinition.function.name;

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
  private parseNestedJsonStrings(obj: any): any {
    if (typeof obj === "string") {
      const parsed = this.tryParseJson(obj);
      if (parsed) {
        return this.parseNestedJsonStrings(parsed);
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.parseNestedJsonStrings(item));
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
  private storeToolResponse(content: string, toolCallId: string): void {
    // Always store the original content for later JQ manipulation
    this.storage[toolCallId] = content;

    // Store metadata for reference
    this.metadataStorage[toolCallId] = {
      toolCallId,
      originalLength: content.length,
      storedAt: Date.now(),
    };
  }

  /**
   * Processes messages to store tool responses silently
   */
  private async processMessage(message: Message): Promise<void> {
    // Only process tool response messages
    if (message.role !== "tool" || !message.tool_call_id || typeof message.content !== "string") {
      return;
    }

    // Store the tool response silently without modifying the message
    this.storeToolResponse(message.content, message.tool_call_id);
  }

  /**
   * Creates a message processor function that stores tool responses silently
   */
  createProcessor(
    filterFn?: (msg: Message) => boolean
  ): MessageProcessorFunction {
    return async (originalMessages: Message[], modifiedMessages: Message[]) => {
      for (const message of modifiedMessages) {
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
  async queryToolResponse(toolCallId: string, jqQuery: string): Promise<string> {
    const data = this.storage[toolCallId];

    if (!data) {
      const availableIds = Object.keys(this.storage);
      return `Error: No tool response found for toolCallId "${toolCallId}". Available IDs: ${availableIds.join(", ")}`;
    }

    try {
      // Parse the data as JSON (handles nested JSON strings)
      const parsedData = this.parseNestedJsonStrings(data);

      // Execute JQ query
      const result = await jq.run(jqQuery, parsedData, { input: "json" });

      // Return the result as a string
      if (typeof result === "string") {
        return result;
      } else {
        return JSON.stringify(result, null, 2);
      }
    } catch (error: any) {
      // If JQ fails, try to provide helpful error message
      let errorMessage = `JQ Query Error: ${error.message}`;

      // Try to parse as JSON to see if it's valid
      const jsonObj = this.tryParseJson(data);
      if (!jsonObj) {
        errorMessage += `\nNote: The tool response data is not valid JSON. Raw data preview:\n${data.substring(0, 300)}...`;
      } else {
        errorMessage += `\nData structure preview:\n${JSON.stringify(jsonObj, null, 2).substring(0, 500)}...`;
      }

      return errorMessage;
    }
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
    if (!toolsService.getTool(this.toolName)) {
      toolsService.addTool(jqToolResponseDefinition);
      toolsService.addFunctions({
        [this.toolName]: async (toolCallId: string, jqQuery: string) => {
          return await this.queryToolResponse(toolCallId, jqQuery);
        },
      });
    }
  }
}

export const jqToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "jqToolResponse",
    description:
      "Execute a JQ query on a stored tool response to extract specific data. Use this when you need to extract specific information from any tool response that has been stored.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        toolCallId: {
          type: "string",
          description: "The toolCallId of the stored tool response",
        },
        jqQuery: {
          type: "string",
          description: "The JQ query to execute on the tool response data (e.g., '.items[0].name', '.data | length', '.[] | select(.status == \"active\")')",
        },
      },
      required: ["toolCallId", "jqQuery"],
    },
  },
};
