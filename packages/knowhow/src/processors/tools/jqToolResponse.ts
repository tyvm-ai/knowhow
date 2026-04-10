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
  availableIds: string[],
  toolNameMap?: { [toolCallId: string]: string }
): Promise<string> {
  if (!data) {
    const idList = availableIds
      .map((id) => {
        const name = toolNameMap?.[id];
        return name ? `${id} (${name})` : id;
      })
      .join("\n  - ");
    return `Error: No tool response found for toolCallId "${toolCallId}". Call listStoredToolResponses to see all available responses with their tool names.\n\nAvailable toolCallIds:\n  - ${idList || "(none)"}`;
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
      "Execute a JQ query on a stored tool response to extract specific data. Use this when you need to extract specific information from any tool response that has been stored. This is the preferred way to search or filter compressed JSON tool responses — it parses the data automatically without requiring repeated expandTokens calls. IMPORTANT: You do NOT know the toolCallId at the time you call a tool — you must call listStoredToolResponses first to discover the correct toolCallId. The listStoredToolResponses output shows each response's tool name so you can identify which response belongs to which call. How to determine the correct JQ query: (1) For mcp_* tool responses (external MCP tools like mcp_1_*): the response is stored as a raw JSON object — use '.' to access the root directly, e.g. '.children | map(.name)' or '.state'. Do NOT use .content[0].text | fromjson for these. (2) For compressed MCP tool responses (._mcp_format === true): use '._data' e.g. '._data.children | map(.name)'. (3) For standard built-in tool responses: data may be nested under '.content[0].text | fromjson'. Use jqToolResponse instead of expandTokens whenever the stored data is JSON.",
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
            "The JQ query to execute on the tool response data. For mcp_* tool responses (raw JSON object): '.children | map({id: .id, name: .name})' (extract fields from children array), '.children | map(select(.state == \"PENDING\")) | length' (count pending children), '.name' (get a top-level field). For compressed responses (._mcp_format true): '._data.children | map(.name)' or '._data | map(select(.state == \"PENDING\")) | length'. For standard built-in tool responses: '.content[0].text | fromjson | map(.title)' (extract titles from standard MCP array), '.content[0].text | fromjson | map(select(.createdAt > \"2025-01-01\"))' (filter by date).",
        },
      },
      required: ["toolCallId", "jqQuery"],
    },
  },
};
