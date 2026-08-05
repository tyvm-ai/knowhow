import { Tool } from "../../clients";

export interface GrepOptions {
  ignoreCase?: boolean;
  invertMatch?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  maxResults?: number;
  resultOffset?: number;
  maxCharacters?: number;
  lineCharacterOffset?: number;
  maxLineCharacters?: number;
}

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 1000;
const DEFAULT_MAX_CHARACTERS = 20_000;
const MAX_CHARACTERS = 50_000;
const DEFAULT_MAX_LINE_CHARACTERS = 4_000;
const MAX_LINE_CHARACTERS = 10_000;
const FOOTER_RESERVE = 700;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  return Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? Math.floor(value as number) : fallback)
  );
}

/** Search stored tool-response text without ever returning an unbounded result. */
export async function executeGrep(
  data: string,
  toolCallId: string,
  pattern: string,
  availableIds: string[],
  options?: GrepOptions,
  toolNameMap?: { [toolCallId: string]: string }
): Promise<string> {
  if (!data) {
    const idList = availableIds
      .map((id) => {
        const name = toolNameMap?.[id];
        return name ? `${id} (${name})` : id;
      })
      .join("\n  - ");
    const maxCharacters = boundedInteger(
      options?.maxCharacters,
      DEFAULT_MAX_CHARACTERS,
      1000,
      MAX_CHARACTERS
    );
    return `Error: No tool response found for toolCallId "${toolCallId}". Call listStoredToolResponses to see all available responses with their tool names.\n\nAvailable toolCallIds:\n  - ${idList || "(none)"}`.slice(
      0,
      maxCharacters
    );
  }

  try {
    const lines = data.split("\n");
    const matchedResults: string[] = [];
    const ignoreCase = options?.ignoreCase ?? false;
    const invertMatch = options?.invertMatch ?? false;
    const contextBefore = boundedInteger(options?.contextBefore, 0, 0, 1000);
    const contextAfter = boundedInteger(options?.contextAfter, 0, 0, 1000);
    const maxResults = boundedInteger(options?.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
    const resultOffset = boundedInteger(options?.resultOffset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxCharacters = boundedInteger(
      options?.maxCharacters,
      DEFAULT_MAX_CHARACTERS,
      1000,
      MAX_CHARACTERS
    );
    const lineCharacterOffset = boundedInteger(
      options?.lineCharacterOffset,
      0,
      0,
      Number.MAX_SAFE_INTEGER
    );
    const maxLineCharacters = boundedInteger(
      options?.maxLineCharacters,
      DEFAULT_MAX_LINE_CHARACTERS,
      100,
      MAX_LINE_CHARACTERS
    );
    const contentBudget = Math.max(1, maxCharacters - FOOTER_RESERVE);
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");

    let totalMatches = 0;
    let outputCharacters = 0;
    let outputTruncated = false;
    const pagedLineNumbers = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const matches = regex.test(lines[i]);
      if (invertMatch ? matches : !matches) continue;

      const resultIndex = totalMatches++;
      const startIdx = Math.max(0, i - contextBefore);
      const endIdx = Math.min(lines.length - 1, i + contextAfter);

      if (
        resultIndex >= resultOffset &&
        matchedResults.length < maxResults &&
        !outputTruncated
      ) {
        const contextLines: string[] = [];
        for (let j = startIdx; j <= endIdx; j++) {
          const sourceLine = lines[j];
          const visibleLine = sourceLine.slice(
            lineCharacterOffset,
            lineCharacterOffset + maxLineCharacters
          );
          const prefix = j === i ? "> " : "  ";
          let rendered = `${prefix}${j + 1}: ${visibleLine}`;

          if (lineCharacterOffset >= sourceLine.length && sourceLine.length > 0) {
            rendered += ` [no characters at offset ${lineCharacterOffset}; line length=${sourceLine.length}]`;
          } else if (lineCharacterOffset + maxLineCharacters < sourceLine.length) {
            pagedLineNumbers.add(j + 1);
            rendered += `\n  [line ${j + 1} truncated; characters ${lineCharacterOffset}-${lineCharacterOffset + visibleLine.length - 1} of ${sourceLine.length}]`;
          }
          contextLines.push(rendered);
        }

        const separatorLength = matchedResults.length > 0 ? 5 : 0;
        const result = contextLines.join("\n");
        const remaining = contentBudget - outputCharacters - separatorLength;
        if (result.length > remaining) {
          if (matchedResults.length === 0 && remaining > 80) {
            matchedResults.push(
              `${result.slice(0, remaining - 48)}\n[result page truncated by maxCharacters]`
            );
            outputCharacters = contentBudget;
          }
          outputTruncated = true;
        } else {
          matchedResults.push(result);
          outputCharacters += separatorLength + result.length;
        }
      }

      // Avoid duplicate result blocks when their after-context overlaps a match.
      i += contextAfter;
    }

    if (totalMatches === 0) {
      const preview = pattern.length > 200 ? `${pattern.slice(0, 200)}…` : pattern;
      return `No matches found for pattern "${preview}" in toolCallId "${toolCallId}"`.slice(
        0,
        maxCharacters
      );
    }

    const consumedResults = matchedResults.length;
    const nextResultOffset = resultOffset + consumedResults;
    const hasMoreResults = nextResultOffset < totalMatches;
    const range = consumedResults
      ? `${resultOffset + 1}-${nextResultOffset}`
      : `none (offset ${resultOffset} is past the final result)`;
    const footerLines = [
      "",
      `[grep page: results ${range} of ${totalMatches}; ${consumedResults} returned; maxCharacters=${maxCharacters}]`,
    ];

    if (pagedLineNumbers.size > 0) {
      footerLines.push(
        `[Long source line(s) ${Array.from(pagedLineNumbers).join(", ")} were sliced. Repeat with options.lineCharacterOffset=${lineCharacterOffset + maxLineCharacters} to read their next characters.]`
      );
    }
    if (hasMoreResults) {
      footerLines.push(
        `[More matches available. Repeat with options.resultOffset=${nextResultOffset}.]`
      );
    } else {
      footerLines.push("[End of matches.]");
    }

    return (matchedResults.join("\n---\n") + footerLines.join("\n")).slice(
      0,
      maxCharacters
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `Grep Error: ${message.slice(0, 500)}`;
  }
}

export const grepToolResponseDefinition: Tool = {
  type: "function",
  function: {
    name: "grepToolResponse",
    description:
      "Search a stored tool response using a regular expression. Results and individual source lines are bounded and paginated. Follow the returned resultOffset or lineCharacterOffset instruction to retrieve more.",
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
          description: "Optional grep, output-bound, and pagination settings.",
          properties: {
            ignoreCase: { type: "boolean", description: "Case-insensitive matching." },
            invertMatch: { type: "boolean", description: "Return non-matching lines." },
            contextBefore: { type: "number", description: "Context lines before a match (maximum 1000)." },
            contextAfter: { type: "number", description: "Context lines after a match (maximum 1000)." },
            maxResults: { type: "number", description: "Matches per page (default 100, maximum 1000)." },
            resultOffset: { type: "number", description: "Zero-based match offset for the next result page." },
            maxCharacters: { type: "number", description: "Response size (default 20000, hard maximum 50000)." },
            lineCharacterOffset: { type: "number", description: "Character offset within every source line, for paging very long lines." },
            maxLineCharacters: { type: "number", description: "Characters shown per source line (default 4000, maximum 10000)." },
          },
        },
      },
      required: ["toolCallId", "pattern"],
    },
  },
};
