import { Tool } from "../../clients";
import * as jq from "node-jq";
import { paginateToolResponse } from "./boundedToolResponse";

export interface JqOptions {
  characterOffset?: number;
  maxCharacters?: number;
}

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
  toolNameMap?: { [toolCallId: string]: string },
  options?: JqOptions
): Promise<string> {
  if (!data) {
    const idList = availableIds
      .map((id) => {
        const name = toolNameMap?.[id];
        return name ? `${id} (${name})` : id;
      })
      .join("\n  - ");
    return paginateToolResponse(
      `Error: No tool response found for toolCallId "${toolCallId}". Call listStoredToolResponses to see all available responses with their tool names.\n\nAvailable toolCallIds:\n  - ${idList || "(none)"}`,
      options,
      "available toolCallId list"
    );
  }

  try {
    // First parse the stored string as JSON, then handle nested JSON strings
    const jsonData = tryParseJson(data);
    if (!jsonData) {
      return paginateToolResponse(
        `Error: Tool response data is not valid JSON for toolCallId "${toolCallId}"`,
        options,
        "jq input error"
      );
    }
    const parsedData = parseNestedJsonStrings(jsonData);

    // Execute JQ query
    const result = await jq.run(jqQuery, parsedData, { input: "json" });

    let rendered: string;
    if (typeof result === "string") {
      rendered = result;
    } else if (typeof result === "number" || typeof result === "boolean") {
      rendered = String(result);
    } else if (result === null) {
      rendered = "null";
    } else {
      rendered = JSON.stringify(result);
    }
    return paginateToolResponse(rendered, options, "jq result");
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

    return paginateToolResponse(errorMessage, options, "jq error");
  }
}

export const jqToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "jqToolResponse",
    description:
      "Execute a JQ query on a stored tool response. Output is bounded to 20,000 characters by default; use options.characterOffset to page through a large result. Prefer a selective JQ query over paging a broad query. Call listStoredToolResponses first to discover the toolCallId. MCP responses are generally rooted at '.' (or '._data' when _mcp_format is true); standard built-in responses may be nested under '.content[0].text | fromjson'.",
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
        options: {
          type: "object",
          description: "Optional output pagination settings.",
          properties: {
            characterOffset: {
              type: "number",
              description: "Zero-based character offset into the rendered JQ result.",
            },
            maxCharacters: {
              type: "number",
              description: "Response size (default 20000, hard maximum 50000).",
            },
          },
        },
      },
      required: ["toolCallId", "jqQuery"],
    },
  },
};
