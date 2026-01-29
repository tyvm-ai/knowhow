import { Tool } from "../../clients";

export interface GrepOptions {
  ignoreCase?: boolean;
  invertMatch?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxResults?: number;
}

/**
 * Grep through tool response data to find matching lines
 */
export async function executeGrep(
  data: string,
  toolCallId: string,
  pattern: string,
  availableIds: string[],
  options?: GrepOptions
): Promise<string> {
  if (!data) {
    return `Error: No tool response found for toolCallId "${toolCallId}". Available IDs: ${availableIds.join(
      ", "
    )}`;
  }

  try {
    const lines = data.split("\n");
    const matchedResults: string[] = [];
    const ignoreCase = options?.ignoreCase || false;
    const invertMatch = options?.invertMatch || false;
    const contextBefore = options?.contextBefore || 0;
    const contextAfter = options?.contextAfter || 0;
    const maxResults = options?.maxResults || 1000;

    // Create regex from pattern
    const flags = ignoreCase ? "i" : "";
    const regex = new RegExp(pattern, flags);

    for (let i = 0; i < lines.length && matchedResults.length < maxResults; i++) {
      const line = lines[i];
      const matches = regex.test(line);
      const shouldInclude = invertMatch ? !matches : matches;

      if (shouldInclude) {
        const startIdx = Math.max(0, i - contextBefore);
        const endIdx = Math.min(lines.length - 1, i + contextAfter);
        
        const contextLines = [];
        for (let j = startIdx; j <= endIdx; j++) {
          const prefix = j === i ? "> " : "  ";
          contextLines.push(`${prefix}${j + 1}: ${lines[j]}`);
        }
        
        matchedResults.push(contextLines.join("\n"));
        
        // Skip ahead to avoid overlapping context
        i += contextAfter;
      }
    }

    if (matchedResults.length === 0) {
      return `No matches found for pattern "${pattern}" in toolCallId "${toolCallId}"`;
    }

    return matchedResults.join("\n---\n");
  } catch (error: any) {
    return `Grep Error: ${error.message}`;
  }
}

export const grepToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "grepToolResponse",
    description:
      "Search through a stored tool response using grep-like pattern matching. Useful when a tool response is too large and you need to find specific lines or content without re-running the tool. Returns matching lines with optional context.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        toolCallId: {
          type: "string",
          description: "The toolCallId of the stored tool response",
        },
        pattern: {
          type: "string",
          description: "Regular expression pattern to search for in the tool response",
        },
        options: {
          type: "object",
          description: "Optional grep settings: ignoreCase (boolean), invertMatch (boolean), contextBefore (number), contextAfter (number), maxResults (number, default: 1000)",
          properties: {},
        },
      },
      required: ["toolCallId", "pattern"],
    },
  },
};
