import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";
import { execSync } from "child_process";

/**
 * Exec Plugin - Execute shell commands from language config
 * This allows language config entries to trigger shell commands
 */
export class ExecPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "exec",
    name: "Exec Plugin",
    requires: [],
  };

  meta = ExecPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  async call(input: string): Promise<string> {
    // Input should be the command to execute
    const command = input.trim();
    
    if (!command) {
      return "EXEC PLUGIN: No command provided";
    }

    try {
      console.log(`EXEC PLUGIN: Executing: ${command}`);
      
      // Execute the command
      const result = execSync(command, {
        encoding: "utf8",
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      console.log(result);

      return `EXEC PLUGIN: Command output from \`${command}\`:\n\`\`\`\n${result}\n\`\`\``;
    } catch (error: any) {
      const errorMessage = error.message;
      const stderr = error.stderr || "";
      const stdout = error.stdout || "";
      
      console.error(`EXEC PLUGIN: Command failed: ${errorMessage}`);
      if (stderr) {
        console.error(stderr);
      }

      return `EXEC PLUGIN: Command \`${command}\` failed:\n\`\`\`\n${stdout}\n${stderr}\n${errorMessage}\n\`\`\``;
    }
  }

  async embed(input: string) {
    return [];
  }
}
