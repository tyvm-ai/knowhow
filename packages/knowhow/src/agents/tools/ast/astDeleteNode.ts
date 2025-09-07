import * as fs from "fs";
import { fileExists } from "../../../utils";
import { services, ToolsService } from "../../../services";
import { LanguageAgnosticParser } from "../../../plugins/tree-sitter/parser";
import { TreeEditor } from "../../../plugins/tree-sitter/editor";

/**
 * Delete a node at a specific path in a file using tree-sitter AST parsing
 */
export async function astDeleteNode(filePath: string, path: string): Promise<string> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();

  const exists = await fileExists(filePath);
  if (!exists) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Read original content for event emission
  let originalContent = "";
  try {
    originalContent = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error.message}`);
  }

  // Emit pre-edit blocking event
  if (context.Events) {
    await context.Events.emitBlocking("file:pre-edit", {
      filePath,
      operation: "ast-delete-node",
      originalContent,
      astPath: path,
    });
  }

  try {
    if (!LanguageAgnosticParser.supportsFile(filePath)) {
      throw new Error(`Unsupported file type for AST parsing: ${filePath}`);
    }

    const parser = LanguageAgnosticParser.createParserForFile(filePath);
    const editor = new TreeEditor(parser, originalContent);
    const updatedEditor = editor.deleteNodeByPath(path);
    const updatedContent = updatedEditor.getCurrentText();

    // Write the updated content back to the file
    fs.writeFileSync(filePath, updatedContent, "utf8");

    // Emit post-edit blocking event (only on success)
    let eventResults: any[] = [];
    if (context.Events) {
      eventResults = await context.Events.emitBlocking("file:post-edit", {
        filePath,
        operation: "ast-delete-node",
        originalContent,
        updatedContent,
        astPath: path,
        success: true,
      });
    }

    const result = {
      file: filePath,
      path,
      action: "delete",
      success: true,
      message: `Successfully deleted node at path: ${path}`,
    };

    // Format event results
    let eventResultsText = "";
    if (eventResults && eventResults.length > 0) {
      eventResultsText =
        "\n\nAdditional Information:\n" +
        JSON.stringify(eventResults, null, 2);
    }

    return JSON.stringify(result, null, 2) + eventResultsText;
  } catch (error: any) {
    // Do NOT emit post-edit event on error
    throw new Error(`Failed to delete node in ${filePath}: ${error.message}`);
  }
}