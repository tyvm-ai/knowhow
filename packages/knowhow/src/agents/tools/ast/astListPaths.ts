import * as fs from "fs";
import { fileExists } from "../../../utils";
import { services, ToolsService } from "../../../services";
import { LanguageAgnosticParser } from "../../../plugins/tree-sitter/parser";
import { TreeEditor } from "../../../plugins/tree-sitter/editor";

/**
 * List all available simple paths in a file using tree-sitter AST parsing
 */
export async function astListPaths(filePath: string): Promise<string> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();

  if (context.Events) {
    await context.Events.emitBlocking("file:pre-read", {
      filePath,
    });
    await context.Events.emitNonBlocking("ast:pre-list-paths", {
      filePath,
    });
  }

  const exists = await fileExists(filePath);
  if (!exists) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");

    if (!LanguageAgnosticParser.supportsFile(filePath)) {
      throw new Error(`Unsupported file type for AST parsing: ${filePath}`);
    }

    const parser = LanguageAgnosticParser.createParserForFile(filePath);
    const editor = new TreeEditor(parser, content);
    const paths = editor.getAllSimplePaths();

    // Emit post-action event
    if (context.Events) {
      await context.Events.emitNonBlocking("file:post-read", {
        filePath,
        content,
      });
      await context.Events.emitNonBlocking("ast:post-list-paths", {
        filePath,
        paths,
      });
    }

    const result = {
      file: filePath,
      language: parser.getLanguage(),
      totalPaths: paths.length,
      paths: paths.sort(),
    };

    return JSON.stringify(result, null, 2);
  } catch (error: any) {
    throw new Error(`Failed to parse file ${filePath}: ${error.message}`);
  }
}
