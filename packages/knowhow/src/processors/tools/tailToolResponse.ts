import { Tool } from "../../clients";

export interface TailOptions {
  lines?: number;
}

/**
 * Get the last n lines from a tool response
 */
export async function executeTail(
  data: string,
  toolCallId: string,
  availableIds: string[],
  options?: TailOptions
): Promise<string> {
  if (data === null || data === undefined) {
    return `Error: No tool response found for toolCallId "${toolCallId}". Available IDs: ${availableIds.join(
      ", "
    )}`;
  }

  try {
    const lines = data.split("\n");
    const numLines = options?.lines ?? 10;

    // Handle edge case: 0 lines requested
    if (numLines <= 0) {
      return "";
    }

    // Get the last n lines
    const startIdx = Math.max(0, lines.length - numLines);
    const tailLines = lines.slice(startIdx);

    // Format with line numbers
    const formatted = tailLines.map((line, idx) => {
      const lineNum = startIdx + idx + 1;
      return `${lineNum}: ${line}`;
    });

    return formatted.join("\n");
  } catch (error: any) {
    return `Tail Error: ${error.message}`;
  }
}

export const tailToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "tailToolResponse",
    description:
      "Get the last n lines from a stored tool response. Similar to the Unix 'tail' command, useful when a tool response is too large and you only need to see the end. Returns the last n lines with line numbers.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        toolCallId: {
          type: "string",
          description: "The toolCallId of the stored tool response",
        },
        options: {
          type: "object",
          description: "Optional tail settings: lines (number, default: 10) - number of lines to return from the end",
          properties: {
            lines: {
              type: "number",
              description: "Number of lines to return from the end (default: 10)",
            },
          },
        },
      },
      required: ["toolCallId"],
    },
  },
};
