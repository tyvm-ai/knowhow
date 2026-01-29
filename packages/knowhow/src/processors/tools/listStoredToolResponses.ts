import { Tool } from "../../clients";

export interface ToolResponseInfo {
  toolCallId: string;
  toolName: string;
  size: number;
  storedAt: number;
  preview: string;
}

/**
 * List all stored tool responses with metadata
 */
export async function executeListStoredToolResponses(
  storage: { [toolCallId: string]: string },
  metadataStorage: {
    [toolCallId: string]: {
      toolCallId: string;
      originalLength: number;
      storedAt: number;
      toolName?: string;
    };
  },
  toolNameMap: { [toolCallId: string]: string }
): Promise<string> {
  const toolCallIds = Object.keys(storage);

  if (toolCallIds.length === 0) {
    return "No tool responses have been stored yet.";
  }

  const responses: ToolResponseInfo[] = toolCallIds.map((toolCallId) => {
    const data = storage[toolCallId];
    const metadata = metadataStorage[toolCallId];
    const toolName = toolNameMap[toolCallId] || "unknown";
    
    // Create a preview (first 100 characters)
    const preview =
      data.length > 100 ? data.substring(0, 100) + "..." : data;

    return {
      toolCallId,
      toolName,
      size: metadata?.originalLength || data.length,
      storedAt: metadata?.storedAt || 0,
      preview,
    };
  });

  // Sort by most recent first
  responses.sort((a, b) => b.storedAt - a.storedAt);

  // Format the output in a readable way
  const output = responses
    .map((resp) => {
      const date = new Date(resp.storedAt).toISOString();
      return `
Tool Call ID: ${resp.toolCallId}
Tool Name: ${resp.toolName}
Size: ${resp.size} characters
Stored At: ${date}
Preview: ${resp.preview}
---`;
    })
    .join("\n");

  return `Found ${responses.length} stored tool response(s):\n${output}`;
}

export const listStoredToolResponsesDefinition: Tool = {
  type: "function",
  function: {
    name: "listStoredToolResponses",
    description:
      "List all stored tool responses with metadata including tool call ID, tool name, size, timestamp, and a preview of the content. Use this to discover which tool responses are available for querying with jqToolResponse or grepToolResponse.",
    parameters: {
      type: "object",
      positional: false,
      properties: {},
      required: [],
    },
  },
};
