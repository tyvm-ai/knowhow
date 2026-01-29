import { Tool } from "../../clients";
import * as jq from "node-jq";

/**
 * Attempts to parse content as JSON and returns parsed object if successful
 */
function tryParseJson(content: string): any | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Recursively searches for JSON strings within an object and parses them
 */
function parseNestedJsonStrings(obj: any): any {
  if (typeof obj === "string") {
    const parsed = tryParseJson(obj);
    if (parsed) {
      return parseNestedJsonStrings(parsed);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => parseNestedJsonStrings(item));
  }

  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = parseNestedJsonStrings(value);
    }
    return result;
  }

  return obj;
}

/**
 * Retrieves and processes tool response data with JQ query
 */
export async function executeJqQuery(
  data: string,
  toolCallId: string,
  jqQuery: string,
  availableIds: string[]
): Promise<string> {
  if (!data) {
    return `Error: No tool response found for toolCallId "${toolCallId}". Available IDs: ${availableIds.join(
      ", "
    )}`;
  }

  try {
    // First parse the stored string as JSON, then handle nested JSON strings
    const jsonData = tryParseJson(data);
    if (!jsonData) {
      return `Error: Tool response data is not valid JSON for toolCallId "${toolCallId}"`;
    }
    const parsedData = parseNestedJsonStrings(jsonData);

    // Execute JQ query
    const result = await jq.run(jqQuery, parsedData, { input: "json" });

    // Handle the result based on its type
    if (typeof result === "string") {
      return result;
    } else if (typeof result === "number" || typeof result === "boolean") {
      return String(result);
    } else if (result === null) {
      return "null";
    } else {
      return JSON.stringify(result);
    }
  } catch (error: any) {
    // If JQ fails, try to provide helpful error message
    let errorMessage = `JQ Query Error: ${error.message}`;

    // Try to parse as JSON to see if it's valid
    const jsonObj = tryParseJson(data);
    if (!jsonObj) {
      errorMessage += `\nNote: The tool response data is not valid JSON. Raw data preview:\n${data.substring(
        0,
        300
      )}...`;
    } else {
      errorMessage += `\nData structure preview:\n${JSON.stringify(
        jsonObj,
        null,
        2
      ).substring(0, 500)}...`;
    }

    return errorMessage;
  }
}

export const jqToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "jqToolResponse",
    description:
      "Execute a JQ query on a stored tool response to extract specific data. Use this when you need to extract specific information from any tool response that has been stored. Many MCP tool responses store data in nested structures like .content[0].text where the actual data array is located.",
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
          description:
            "The JQ query to execute on the tool response data. Examples: '.content[0].text | map(.title)' (extract titles from MCP array), '.content[0].text | map(select(.createdAt > \"2025-01-01\"))' (filter MCP items by date) ",
        },
      },
      required: ["toolCallId", "jqQuery"],
    },
  },
};
