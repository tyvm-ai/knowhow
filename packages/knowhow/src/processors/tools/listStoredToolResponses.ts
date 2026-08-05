import { Tool } from "../../clients";
import { boundedInteger, paginateToolResponse } from "./boundedToolResponse";

export interface ListStoredToolResponsesOptions {
  resultOffset?: number;
  maxResults?: number;
  characterOffset?: number;
  maxCharacters?: number;
}

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
  toolNameMap: { [toolCallId: string]: string },
  options?: ListStoredToolResponsesOptions
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

  const resultOffset = boundedInteger(options?.resultOffset, 0, 0, responses.length);
  const maxResults = boundedInteger(options?.maxResults, 100, 1, 1000);
  const page = responses.slice(resultOffset, resultOffset + maxResults);
  const output = page
    .map((resp) => {
      const date = new Date(resp.storedAt).toISOString();
      return `
Tool Call ID: ${resp.toolCallId.slice(0, 500)}
Tool Name: ${resp.toolName.slice(0, 500)}
Size: ${resp.size} characters
Stored At: ${date}
Preview: ${resp.preview}
---`;
    })
    .join("\n");

  const nextOffset = resultOffset + page.length;
  const footer = nextOffset < responses.length
    ? `\n[More stored responses available. Repeat with options.resultOffset=${nextOffset}.]`
    : "\n[End of stored responses.]";
  return paginateToolResponse(
    `Found ${responses.length} stored tool response(s); showing ${resultOffset + 1}-${nextOffset}:\n${output}${footer}`,
    options,
    "stored-response list"
  );
}

export const listStoredToolResponsesDefinition: Tool = {
  type: "function",
  function: {
    name: "listStoredToolResponses",
    description:
      "List a bounded page of stored tool responses with IDs, tool names, sizes, timestamps, and previews. Call this before jqToolResponse, grepToolResponse, or tailToolResponse to discover a toolCallId.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        options: {
          type: "object",
          description: "Optional result and output pagination settings.",
          properties: {
            resultOffset: {
              type: "number",
              description: "Zero-based response offset (default 0).",
            },
            maxResults: {
              type: "number",
              description: "Responses per page (default 100, maximum 1000).",
            },
            characterOffset: {
              type: "number",
              description: "Character offset within the rendered page.",
            },
            maxCharacters: {
              type: "number",
              description: "Response size (default 20000, hard maximum 50000).",
            },
          },
        },
      },
    },
  },
};
