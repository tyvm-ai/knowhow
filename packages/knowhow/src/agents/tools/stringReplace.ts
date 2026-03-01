import * as fs from "fs";
import { services, ToolsService } from "../../services";
import { fileExists } from "../../utils";

export async function stringReplace(
  findString: string,
  replaceString: string,
  filePaths: string[]
): Promise<string> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;
  const context = toolService.getContext();

  if (
    !findString ||
    replaceString === undefined ||
    !filePaths ||
    filePaths.length === 0
  ) {
    throw new Error(
      "findString, replaceString, and filePaths are all required parameters"
    );
  }

  const results: string[] = [];
  let totalReplacements = 0;

  for (const filePath of filePaths) {
    try {
      const exists = await fileExists(filePath);
      if (!exists) {
        results.push(`❌ File not found: ${filePath}`);
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");
      const originalContent = content;

      // Count occurrences before replacement
      const matches = content.split(findString).length - 1;

      if (matches === 0) {
        results.push(`ℹ️  No matches found in: ${filePath}`);
        continue;
      }

      // Emit pre-edit blocking event
      const eventResults: any[] = [];
      if (context.Events) {
        eventResults.push(
          ...(await context.Events.emitBlocking("file:pre-edit", {
            filePath,
            operation: "stringReplace",
            findString,
            replaceString,
            originalContent,
          }))
        );
      }

      // Perform the replacement
      const newContent = content.replace(
        new RegExp(findString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        replaceString
      );

      // Write the modified content back to the file
      fs.writeFileSync(filePath, newContent);

      totalReplacements += matches;
      results.push(`✅ Replaced ${matches} occurrence(s) in: ${filePath}`);

      // Emit post-edit blocking event to get event results
      if (context.Events) {
        eventResults.push(
          ...(await context.Events.emitBlocking("file:post-edit", {
            filePath,
            operation: "stringReplace",
            findString,
            replaceString,
            originalContent,
            updatedContent: newContent,
          }))
        );
      }

      // Format event results if any
      if (eventResults && eventResults.length > 0) {
        const eventResultsText = eventResults
          .filter((r) => r && typeof r === "string" && r.trim())
          .join("\n");
        if (eventResultsText) {
          results.push(eventResultsText);
        }
      }
    } catch (error) {
      results.push(`❌ Error processing ${filePath}: ${error.message}`);
    }
  }

  const summary = `\n📊 Summary: ${totalReplacements} total replacements made across ${filePaths.length} file(s)`;
  return results.join("\n") + summary;
}
