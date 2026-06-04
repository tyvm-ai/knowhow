import * as fs from "fs";
import { fileExists } from "../../utils";
import { services, ToolsService } from "../../services";
import { getConfiguredEmbeddings } from "../../embeddings";
import { fileSearch } from "./fileSearch";

/*
 *export function readFile(filePath: string): string {
 *  try {
 *    const text = fs.readFileSync(filePath, "utf8");
 *    return JSON.stringify(
 *      text.split("\n").map((line, index) => [index + 1, line])
 *    );
 *  } catch (e) {
 *    return e.message;
 *  }
 *}
 */

/**
 * Reads the contents of a file and returns them as plain text.
 *
 * Optionally accepts a 1-based, inclusive line range so callers can pull just
 * the region they care about in a single call. When a range is supplied the
 * returned content is prefixed with real source line numbers so the output can
 * be mapped straight back to an editable location.
 *
 * @param filePath The path to the file to read
 * @param fromLine Optional 1-based start line (inclusive)
 * @param toLine Optional 1-based end line (inclusive)
 */
export async function readFile(
  filePath: string,
  fromLine?: number,
  toLine?: number
): Promise<string> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();

  // Emit pre-read blocking event
  if (context.Events) {
    await context.Events.emitBlocking("file:pre-read", {
      filePath,
    });
  }

  const exists = await fileExists(filePath);

  if (!exists) {
    const fileName = filePath.split("/").pop().split(".")[0];
    const maybeRelated = await fileSearch(fileName);
    if (maybeRelated.length > 0) {
      throw new Error(
        `File not found: ${filePath}. Maybe you meant one of these files: ${maybeRelated}`
      );
    }

    throw new Error(`File not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, "utf8");

  // Emit post-read non-blocking event with the full file content so listeners
  // (e.g. indexers) always see the complete file regardless of any range slice.
  if (context.Events) {
    await context.Events.emitNonBlocking("file:post-read", {
      filePath,
      content: text,
    });
  }

  const hasRange =
    typeof fromLine === "number" || typeof toLine === "number";

  if (!hasRange) {
    return text;
  }

  // Build a ranged read with real, 1-based source line numbers.
  const lines = text.split("\n");
  const totalLines = lines.length;

  const start = Math.max(1, typeof fromLine === "number" ? fromLine : 1);
  const end = Math.min(
    totalLines,
    typeof toLine === "number" ? toLine : totalLines
  );

  if (start > end) {
    throw new Error(
      `Invalid line range for ${filePath}: fromLine (${start}) is greater than toLine (${end}). File has ${totalLines} lines.`
    );
  }

  const numbered = [];
  for (let i = start; i <= end; i++) {
    numbered.push(`${i}: ${lines[i - 1]}`);
  }

  return numbered.join("\n");
}
