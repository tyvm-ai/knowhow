import { getConfig } from "../config";
import { execCommand } from "../agents/tools";
import { PluginBase, PluginMeta } from "./PluginBase";

export class LinterPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "linter",
    name: "Linter Plugin",
    requires: [],
  };

  meta = LinterPlugin.meta;

  constructor(context) {
    super(context);

    // Subscribe to file:post-edit events
    this.context.Events.onBlocking(
      "file:post-edit",
      this.handleFilePostEdit.bind(this)
    );

    this.context.Events.onBlocking(
      "git:pre-commit",
      this.handleFilesPreCommit.bind(this)
    );
  }

  async embed() {
    return [];
  }

  async call(userPrompt: string): Promise<string> {
    return "";
  }

  async handleFilesPreCommit(payload: { files: string[] }): Promise<string> {
    const { files = [] } = payload;
    let lintResult = "";
    for (const filePath of files) {
      const result = await this.lintFile(filePath);
      if (result) {
        lintResult += `Results for ${filePath}:\n${result}\n\n`;
      }
    }
    return lintResult || "[Build Stable] No linting issues found";
  }

  /**
   * Handle file:post-edit events by linting the file
   * @param payload The event payload containing filePath
   * @returns The linting results as a string
   */
  async handleFilePostEdit(payload: { filePath: string }): Promise<string> {
    const { filePath } = payload;
    const lintResult = await this.lintFile(filePath);
    return lintResult || "No linting issues found";
  }

  /**
   * Lint a file and return the results
   * @param filePath The path to the file to lint
   * @returns The linting results as a string
   */
  async lintFile(filePath: string): Promise<string> {
    const config = await getConfig();
    const extension = filePath.split(".").pop();

    if (config.lintCommands && config.lintCommands[extension]) {
      let lintCommand = config.lintCommands[extension];
      if (lintCommand.includes("$1")) {
        lintCommand = lintCommand.replace("$1", filePath);
      }

      try {
        const lintResult = await execCommand(`${lintCommand}`, 0, false, true);
        console.log("Lint Result:", lintResult);
        return lintResult;
      } catch (error) {
        console.error("Linting failed:", error);
        return `Linting failed: ${error}`;
      }
    }

    return "";
  }
}
