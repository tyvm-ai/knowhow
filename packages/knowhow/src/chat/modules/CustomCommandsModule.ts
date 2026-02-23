import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand } from "../types";
import { getLanguageConfig } from "../../config";

/**
 * CustomCommandsModule - Loads `/command`-style keys from the language config
 * and registers them as chat commands. When invoked, the resolved language
 * sources are sent to the active agent via addPendingUserMessage.
 */
export class CustomCommandsModule extends BaseChatModule {
  name = "custom-commands";
  description = "Dynamically registered commands from language config /command keys";

  public getCommands(): ChatCommand[] {
    // Commands are loaded asynchronously; return empty here and register dynamically in initialize
    return [];
  }

  async initialize(service: import("../types").ChatService): Promise<void> {
    this.chatService = service;

    // Load language config and register /command-style keys
    try {
      const languageConfig = await getLanguageConfig();
      const commandKeys = Object.keys(languageConfig).filter((key) =>
        key.trim().startsWith("/")
      );

      for (const commandKey of commandKeys) {
        // Strip the leading slash to get the command name
        const commandName = commandKey.trim().slice(1);

        const command: ChatCommand = {
          name: commandName,
          description: `Custom command: ${commandKey}`,
          handler: async (args: string[]) => {
            await this.handleCustomCommand(commandKey, args);
          },
        };

        this.chatService.registerCommand(command);
      }
    } catch (error) {
      console.error("CUSTOM-COMMANDS: Error loading language config:", error);
    }
  }

  private async handleCustomCommand(commandKey: string, args: string[]): Promise<void> {
    try {
      const languagePlugin = this.chatService
        ? (this.chatService as any).context?.Plugins?.getPlugin?.("language")
        : null;

      let resolvedContent: string = "";

      if (languagePlugin && typeof languagePlugin.call === "function") {
        // Call the language plugin with the command key to resolve its sources
        resolvedContent = await languagePlugin.call(commandKey);
      } else {
        // Fallback: load the sources directly from language config
        const languageConfig = await getLanguageConfig();
        const termConfig = languageConfig[commandKey];
        if (termConfig) {
          const fileSources = termConfig.sources
            .filter((s) => s.kind === "text")
            .flatMap((s) => s.data);
          resolvedContent = fileSources.join("\n");
        }
      }

      if (!resolvedContent) {
        console.log(`No content resolved for command ${commandKey}`);
        return;
      }

      // Send resolved content to the active agent
      const context = this.chatService?.getContext();
      const agent = context?.selectedAgent;

      if (agent && typeof agent.addPendingUserMessage === "function") {
        agent.addPendingUserMessage({
          role: "user",
          content: resolvedContent,
        });
        console.log(`Custom command /${commandKey.slice(1)} sent to agent.`);
      } else {
        // No active agent - just print the resolved content
        console.log(`\n[Custom Command: ${commandKey}]\n${resolvedContent}\n`);
      }
    } catch (error) {
      console.error(`CUSTOM-COMMANDS: Error handling command ${commandKey}:`, error);
    }
  }
}
