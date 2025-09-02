import * as fs from "fs";
import { fileExists } from "../../utils";
import { services, ToolsService } from "../../services";
import { getConfiguredEmbeddings } from "../../embeddings";
import { fileSearch } from "./fileSearch";
import { createPatch } from "diff";

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

export async function readFile(filePath: string): Promise<string> {
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
  const patch = createPatch(filePath, "", text);

  // Emit post-read non-blocking event
  if (context.Events) {
    await context.Events.emitNonBlocking("file:post-read", {
      filePath,
      content: text,
    });
  }

  return patch;
}
