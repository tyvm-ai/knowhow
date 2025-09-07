import * as fs from "fs";
import { fileExists } from "../../../utils";
import { services, ToolsService } from "../../../services";
import { LanguageAgnosticParser } from "../../../plugins/tree-sitter/parser";
import { TreeEditor } from "../../../plugins/tree-sitter/editor";

/**
 * Get the AST path for a specific line of text in a file using tree-sitter parsing
 */
export async function astGetPathForLine(filePath: string, searchText: string): Promise<string> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();

  // Emit pre-action event
  if (context.Events) {
    await context.Events.emitBlocking("ast:pre-get-path-for-line", {
      filePath,
      searchText,
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
    const tree = parser.parseString(content);
    const pathLocations = parser.findPathsForLine(tree, searchText);

    // Emit post-action event
    if (context.Events) {
      await context.Events.emitNonBlocking("ast:post-get-path-for-line", {
        filePath,
        searchText,
        pathCount: pathLocations.length,
      });
    }

    // Get file extension for result metadata
    const ext = filePath.split('.').pop()?.toLowerCase();

    const result = {
      file: filePath,
      searchText,
      language: ext,
      totalMatches: pathLocations.length,
      matches: pathLocations.map(loc => ({
        path: loc.path,
        line: loc.row + 1, // Convert from 0-based to 1-based line numbering
        column: loc.column + 1, // Convert from 0-based to 1-based column numbering
        text: loc.text,
      })),
    };

    return JSON.stringify(result, null, 2);
  } catch (error: any) {
    throw new Error(`Failed to get path for line in ${filePath}: ${error.message}`);
  }
}