import { Tool } from "../../clients";
import { boundedInteger, paginateToolResponse } from "./boundedToolResponse";

export interface TailOptions {
  lines?: number;
  endLine?: number;
  lineCharacterOffset?: number;
  maxLineCharacters?: number;
  characterOffset?: number;
  maxCharacters?: number;
}

/**
 * Get the last n lines from a tool response
 */
export async function executeTail(
  data: string,
  toolCallId: string,
  availableIds: string[],
  options?: TailOptions,
  toolNameMap?: { [toolCallId: string]: string }
): Promise<string> {
  if (data === null || data === undefined) {
    const idList = availableIds
      .map((id) => {
        const name = toolNameMap?.[id];
        return name ? `${id} (${name})` : id;
      })
      .join("\n  - ");
    return paginateToolResponse(
      `Error: No tool response found for toolCallId "${toolCallId}". Call listStoredToolResponses to see all available responses with their tool names.\n\nAvailable toolCallIds:\n  - ${idList || "(none)"}`,
      {
        characterOffset: options?.characterOffset,
        maxCharacters: options?.maxCharacters,
      },
      "available toolCallId list"
    );
  }

  try {
    const lines = data.split("\n");
    const numLines = boundedInteger(options?.lines, 10, 0, 1000);

    if (numLines <= 0) {
      return "";
    }

    const endLine = boundedInteger(options?.endLine, lines.length, 1, lines.length);
    const startIdx = Math.max(0, endLine - numLines);
    const lineCharacterOffset = boundedInteger(
      options?.lineCharacterOffset,
      0,
      0,
      Number.MAX_SAFE_INTEGER
    );
    const maxLineCharacters = boundedInteger(
      options?.maxLineCharacters,
      4000,
      100,
      10_000
    );
    const longLines: number[] = [];

    const formatted = lines.slice(startIdx, endLine).map((line, idx) => {
      const lineNumber = startIdx + idx + 1;
      const visible = line.slice(
        lineCharacterOffset,
        lineCharacterOffset + maxLineCharacters
      );
      if (lineCharacterOffset + maxLineCharacters < line.length) {
        longLines.push(lineNumber);
      }
      return `${lineNumber}: ${visible}`;
    });

    const notes: string[] = [];
    if (typeof options?.endLine === "number" && startIdx > 0) {
      notes.push(`[Earlier lines available: repeat with options.endLine=${startIdx}.]`);
    }
    if (longLines.length > 0) notes.push(`[Long lines ${longLines.join(", ")} were sliced; repeat with options.lineCharacterOffset=${lineCharacterOffset + maxLineCharacters}.]`);
    const rendered =
      formatted.join("\n") +
      (notes.length > 0 ? `\n\n${notes.join("\n")}` : "");
    return paginateToolResponse(
      rendered,
      {
        characterOffset: options?.characterOffset,
        maxCharacters: options?.maxCharacters,
      },
      "tail result"
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Tail Error: ${message.slice(0, 500)}`;
  }
}

export const tailToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "tailToolResponse",
    description:
      "Get a bounded page of lines from the end of a stored tool response. Use endLine to page backward and lineCharacterOffset to page through unusually long lines.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        toolCallId: {
          type: "string",
          description: "The toolCallId of the stored tool response.",
        },
        options: {
          type: "object",
          description: "Optional tail and pagination settings.",
          properties: {
            lines: {
              type: "number",
              description: "Lines per page (default 10, maximum 1000).",
            },
            endLine: {
              type: "number",
              description:
                "1-based inclusive line at which the page ends; use the returned value to page backward.",
            },
            lineCharacterOffset: {
              type: "number",
              description: "Character offset within each source line.",
            },
            maxLineCharacters: {
              type: "number",
              description:
                "Characters shown per line (default 4000, maximum 10000).",
            },
            characterOffset: {
              type: "number",
              description: "Character offset within the rendered tail page.",
            },
            maxCharacters: {
              type: "number",
              description: "Response size (default 20000, hard maximum 50000).",
            },
          },
        },
      },
      required: ["toolCallId"],
    },
  },
};
