import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatService, CommandResult } from "../types";
import { getLanguageConfig } from "../../config";

/**
 * CustomCommandsModule - Loads `/command`-style keys from the language config
 * and registers them as chat commands. When invoked, the resolved language
 * sources are sent to the active agent via addPendingUserMessage.
 */
export class CustomCommandsModule extends BaseChatModule {
  name = "custom-commands";
  description =
    "Dynamically registered commands from language config /command keys";

  public getCommands(): ChatCommand[] {
    // Commands are loaded asynchronously; return empty here and register dynamically in initialize
    return [];
  }

  async initialize(service: ChatService): Promise<void> {
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

        console.log(
          `CUSTOM-COMMANDS: Registering command /${commandName} from language config`
        );

        const command: ChatCommand = {
          name: commandName,
          description: `Custom command: ${commandKey}`,
          modes: ["agent:attached", "agent"],
          handler: async (args: string[]): Promise<CommandResult> => {
            // Return unhandled with the original command so modules can process it
            // The language plugin will expand it
            return {
              handled: false,
              contents: commandKey,
            };
          },
        };

        this.chatService.registerCommand(command);
      }
    } catch (error) {
      console.error("CUSTOM-COMMANDS: Error loading language config:", error);
    }
  }
}
