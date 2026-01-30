import * as fs from "fs";
import { services, ToolsService } from "../../services";

// Tool to write the full contents of a file
export function writeFile(filePath: string, content: string): string {
  try {
    fs.writeFileSync(filePath, content);
    return `File ${filePath} written`;
  } catch (e) {
    return e.message;
  }
}

export async function writeFileChunk(
  filePath: string,
  content: string,
  isContinuing: boolean,
  isDone: boolean
) {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;
  const context = toolService.getContext();

  if (!filePath || content === undefined) {
    throw new Error(
      `File path and content are both required. We received: ${JSON.stringify({
        filePath,
        content,
      })}. Make sure you write small chunks of content, otherwise you will hit output limits, resulting in content being empty.`
    );
  }

  // Read original content for event emission
  let originalContent = "";
  try {
    if (fs.existsSync(filePath)) {
      originalContent = fs.readFileSync(filePath, "utf8");
    }
  } catch (error) {
    // If we can't read the original file, continue with empty string
    originalContent = "";
  }

  // Emit pre-edit blocking event
  if (context.Events) {
    await context.Events.emitBlocking("file:pre-edit", {
      filePath,
      operation: isContinuing ? "append" : "write",
      content,
      originalContent,
    });
  }

  if (!isContinuing) {
    fs.writeFileSync(filePath, content);
  }

  if (isContinuing) {
    fs.appendFileSync(filePath, "\n" + content);
  }

  let message = "";

  if (isContinuing) {
    message = "Appended content to file.";
  }

  if (!isDone) {
    message += " Continue calling this tool until file is done.";
  }

  if (isDone) {
    message = " File write complete. Use readFile to verify";

    // Emit post-edit blocking event to get event results
    let eventResults: any[] = [];
    if (context.Events) {
      // Read updated content for event emission
      const updatedContent = fs.readFileSync(filePath, "utf8");

      eventResults = await context.Events.emitBlocking("file:post-edit", {
        filePath,
        operation: "write",
        content,
        originalContent,
        updatedContent,
      });
    }

    // Format event results
    let eventResultsText = "";
    if (eventResults && eventResults.length > 0) {
      if (eventResults.length > 0) {
        eventResultsText =
          "\n\nAdditional Information:\n" +
          JSON.stringify(eventResults, null, 2);
      }
    }

    message += eventResultsText;
  }

  return message;
}
