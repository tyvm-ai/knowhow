import * as fs from "fs";
import { embed } from "../../";
import { lintFile } from ".";
import { ToolsService } from "../..";
import { services } from "../../services";

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
  const toolService = (this instanceof ToolsService ? this : services().Tools) as ToolsService;
  const context = toolService.getContext();

  if (!filePath || content === undefined) {
    throw new Error(
      "File path and content are both required. Make sure you write small chunks of content, otherwise you may hit output limits."
    );
  }

  // Read original content for event emission
  let originalContent = "";
  try {
    if (fs.existsSync(filePath)) {
      originalContent = fs.readFileSync(filePath, 'utf8');
    }
  } catch (error) {
    // If we can't read the original file, continue with empty string
    originalContent = "";
  }

  // Emit pre-edit blocking event
  if (context.Events) {
      await context.Events.emitBlocking('file:pre-edit', {
        filePath,
        operation: isContinuing ? 'append' : 'write',
        content,
        originalContent
      });
    } catch (error) {
      throw new Error(`File operation blocked by pre-edit event handler: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!isContinuing) {
    fs.writeFileSync(filePath, content);
    
    // Emit post-edit non-blocking event
    if (context.Events) {
      try {
        await context.Events.emitNonBlocking('file:post-edit', {
          filePath,
          operation: 'write',
          content,
          originalContent,
          updatedContent: content
        });
      } catch (error) {
        // Non-blocking events log errors but continue
        console.warn(`Post-edit event handler error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Read updated content for event emission
    let updatedContent = "";
    try {
      updatedContent = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      // If we can't read the updated file, use original + appended content as fallback
      updatedContent = originalContent + content;
    }
    
    // Emit post-edit non-blocking event
    if (context.Events) {
      try {
        await context.Events.emitNonBlocking('file:post-edit', {
          filePath,
          operation: 'append',
          content,
          originalContent,
          updatedContent
        });
      } catch (error) {
        // Non-blocking events log errors but continue
        console.warn(`Post-edit event handler error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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

    let lintResult = "";
    try {
      lintResult = await lintFile(filePath);
      message += `${
        lintResult ? "\nLinting Result:\n" + lintResult : ""
      }`.trim();
    } catch (lintError: any) {
      console.warn("Linting failed after patching:", lintError);
      lintResult = `Linting after patch failed: ${lintError.message}`;
    }

    await embed();
  }

  return message;
}
