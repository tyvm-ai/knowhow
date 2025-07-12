import * as fs from "fs";
import { fileExists } from "../../utils";

export async function stringReplace(
  findString: string,
  replaceString: string,
  filePaths: string[]
): Promise<string> {
  if (!findString || replaceString === undefined || !filePaths || filePaths.length === 0) {
    throw new Error("findString, replaceString, and filePaths are all required parameters");
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

      // Perform the replacement
      const newContent = content.replace(new RegExp(findString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replaceString);
      
      // Write the modified content back to the file
      fs.writeFileSync(filePath, newContent);
      
      totalReplacements += matches;
      results.push(`✅ Replaced ${matches} occurrence(s) in: ${filePath}`);
      
    } catch (error) {
      results.push(`❌ Error processing ${filePath}: ${error.message}`);
    }
  }

  const summary = `\n📊 Summary: ${totalReplacements} total replacements made across ${filePaths.length} file(s)`;
  return results.join("\n") + summary;
}