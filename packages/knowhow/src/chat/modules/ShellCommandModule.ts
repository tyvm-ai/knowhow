import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatContext, CommandResult } from "../types";
import { execSync } from "child_process";

/**
 * ShellCommandModule - Handles /! and /!! commands for executing shell commands
 * /! - Execute command and display output in console (interactive if needed)
 * /!! - Execute command and send output to the AI agent
 */
export class ShellCommandModule extends BaseChatModule {
  name = "shell-command";
  description = "Execute shell commands with /! and /!!";

  public getCommands(): ChatCommand[] {
    return [
      {
        name: "!",
        description: "Execute a shell command (interactive)",
        modes: ["agent", "agent:attached"],
        handler: async (args: string[]): Promise<CommandResult> => {
          const command = args.join(" ");
          if (!command) {
            console.log("Usage: /! <command>");
            return { handled: true };
          }

          try {
            console.log(`Executing: ${command}`);
            // Execute the command and inherit stdio for interactivity
            const result = execSync(command, {
              encoding: "utf8",
              stdio: "inherit",
              cwd: process.cwd(),
            });
            
            return { handled: true };
          } catch (error: any) {
            console.error(`Command failed: ${error.message}`);
            if (error.stderr) {
              console.error(error.stderr);
            }
            return { handled: true };
          }
        },
      },
      {
        name: "!!",
        description: "Execute a shell command and send output to AI",
        modes: ["agent", "agent:attached"],
        handler: async (args: string[]): Promise<CommandResult> => {
          const command = args.join(" ");
          if (!command) {
            console.log("Usage: /!! <command>");
            return { handled: true };
          }

          try {
            console.log(`Executing: ${command}`);
            const result = execSync(command, {
              encoding: "utf8",
              cwd: process.cwd(),
            });

            console.log(result);

            // Return unhandled with the command output so it gets sent to the agent
            return {
              handled: false,
              contents: `Command output from \`${command}\`:\n\`\`\`\n${result}\n\`\`\``,
            };
          } catch (error: any) {
            const errorMessage = error.message;
            const stderr = error.stderr || "";
            const stdout = error.stdout || "";
            
            console.error(`Command failed: ${errorMessage}`);
            if (stderr) {
              console.error(stderr);
            }

            // Send error output to agent as well
            return {
              handled: false,
              contents: `Command \`${command}\` failed:\n\`\`\`\n${stdout}\n${stderr}\n${errorMessage}\n\`\`\``,
            };
          }
        },
      },
    ];
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    // This module only handles commands registered above
    return false;
  }
}
