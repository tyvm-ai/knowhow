import { BaseChatModule } from "./BaseChatModule";
import { CliChatService } from "../CliChatService";
import { ChatCommand, ChatMode, ChatContext } from "../types";
import { ask } from "../../utils";
import { services } from "../../services";
import { Models } from "../../types";

export class SystemModule extends BaseChatModule {
  name = "system";
  description = "System commands for model, provider, debug, and clear";

  getCommands(): ChatCommand[] {
    return [
      {
        name: "model",
        description: "Select AI model",
        handler: this.handleModelCommand.bind(this),
      },
      {
        name: "provider",
        description: "Select AI provider",
        handler: this.handleProviderCommand.bind(this),
      },
      {
        name: "debug",
        description: "Toggle debug mode",
        handler: this.handleDebugCommand.bind(this),
      },
      {
        name: "clear",
        description: "Clear chat history - AI will not remember previous messages",
        handler: this.handleClearCommand.bind(this),
      },
    ];
  }

  getModes(): ChatMode[] {
    return [];
  }

  async handleModelCommand(args: string[]): Promise<void> {
    const context = this.chatService?.getContext();
    const { Clients } = services();

    const currentProvider = context?.currentProvider || "openai";
    const currentModel = context?.currentModel || "gpt-4o";

    const models = Clients.getRegisteredModels(currentProvider);
    console.log(models);

    const selectedModel = await ask(
      `\n\nCurrent Provider: ${currentProvider}\nCurrent Model: ${currentModel}\n\nWhich model would you like to use: `,
      models
    );

    this.chatService?.setContext({
      currentModel: selectedModel,
      currentProvider,
    });
    console.log(`Model set to: ${selectedModel}`);

    // Update currently active agent if any
    if (context?.selectedAgent) {
      console.log(
        `Updating active agent ${context.currentAgent} model to: ${selectedModel}`
      );
      context?.selectedAgent?.updatePreferences({
        model: selectedModel,
        provider: currentProvider as any,
      });
    }
  }

  async handleProviderCommand(args: string[]): Promise<void> {
    const context = this.chatService?.getContext();
    const { Clients } = services();

    const currentProvider = context?.currentProvider || "openai";
    const currentModel = context?.currentModel || "gpt-4o";

    const providers = Object.keys(Clients.clients);
    console.log(providers);

    const selectedProvider = await ask(
      `\n\nCurrent Provider: ${currentProvider}\nCurrent Model: ${currentModel}\n\nWhich provider would you like to use: `,
      providers
    );

    // Get default model for new provider
    const ChatModelDefaults = {
      openai: Models.openai.GPT_5,
      anthropic: Models.anthropic.Sonnet4,
      google: Models.google.Gemini_25_Flash_Preview,
      xai: Models.xai.GrokCodeFast,
    };

    const newModel =
      ChatModelDefaults[selectedProvider] ||
      (await Clients.getRegisteredModels(selectedProvider))[0];

    this.chatService?.setContext({
      currentProvider: selectedProvider,
      currentModel: newModel,
    });

    console.log(
      `Provider set to: ${selectedProvider}, Model set to: ${newModel}`
    );

    // Update currently active agent if any
    if (context?.selectedAgent) {
      console.log(
        `Updating active agent ${context.currentAgent} provider to: ${selectedProvider} and model to: ${newModel}`
      );

      context?.selectedAgent?.updatePreferences({
        model: newModel,
        provider: selectedProvider as any,
      });
    }
  }

  async handleDebugCommand(args: string[]): Promise<void> {
    const context = this.chatService?.getContext();
    const newDebugMode = !context?.debugMode;

    this.chatService?.setContext({ debugMode: newDebugMode });
    console.log(`Debug mode: ${newDebugMode ? "enabled" : "disabled"}`);
  }

  async handleClearCommand(args: string[]): Promise<void> {
    (this.chatService as CliChatService)?.clearHistory();
    console.log("Chat history cleared.");
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    return false; // Commands are handled separately
  }

  async cleanup(): Promise<void> {
    // No cleanup needed
  }
}
