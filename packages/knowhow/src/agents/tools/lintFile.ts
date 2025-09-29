import { getConfig } from "../../config";
import { execCommand } from ".";
export async function lintFile(filePath: string) {
  const config = await getConfig();
  const extension = filePath.split(".").pop();
  let lintResult = "";
  if (config.lintCommands && config.lintCommands[extension]) {
    let lintCommand = config.lintCommands[extension];
    if (lintCommand.includes("$1")) {
      lintCommand = lintCommand.replace("$1", filePath);
    }
    lintResult = await execCommand(`${lintCommand}`, -1);
    if (lintResult) {
      console.log("Lint Result:", lintResult);
    }
    return lintResult;
  }
  return "";
}
