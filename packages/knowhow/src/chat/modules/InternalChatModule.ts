import { ChatModule } from "../types";
import { CliChatService } from "../CliChatService";
import { AgentModule } from "./AgentModule";
import { ChatCommand, ChatMode, ChatContext } from "../types";
import { AskModule } from "./AskModule";
import { SearchModule } from "./SearchModule";
import { VoiceModule } from "./VoiceModule";
import { SystemModule } from "./SystemModule";
import { SetupModule } from "./SetupModule";
import { CustomCommandsModule } from "./CustomCommandsModule";
import { ShellCommandModule } from "./ShellCommandModule";

export class InternalChatModule implements ChatModule {
  private chatService?: CliChatService;
  name = "internal";
  description = "Internal chat module aggregating all functionality";
  commands: ChatCommand[] = [];
  modes: ChatMode[] = [];
  private agentModule = new AgentModule();
  private askModule = new AskModule();
  private searchModule = new SearchModule();
  private voiceModule = new VoiceModule();
  private systemModule = new SystemModule();
  private setupModule = new SetupModule();
  private customCommandsModule = new CustomCommandsModule();
  private shellCommandModule = new ShellCommandModule();

  async initialize(chatService: CliChatService): Promise<void> {
    this.chatService = chatService;

    // Register this module first so it gets called for input handling
    chatService.registerModule(this);

    // Initialize all sub-modules
    await this.agentModule.initialize(chatService);
    await this.askModule.initialize(chatService);
    await this.searchModule.initialize(chatService);
    await this.voiceModule.initialize(chatService);
    await this.systemModule.initialize(chatService);
    await this.setupModule.initialize(chatService);
    await this.customCommandsModule.initialize(chatService);
    await this.shellCommandModule.initialize(chatService);
    
    // Register our own commands (exit and multi) - not duplicated by BaseChatModule
    chatService.registerCommand({
      name: "exit",
      description: "Exit the chat",
      handler: this.handleExitCommand.bind(this),
    });

    chatService.registerCommand({
      name: "multi",
      description: "Toggle multiline mode",
      handler: this.handleMultiCommand.bind(this),
    });


    for (const mode of this.getModes()) {
      chatService.registerMode(mode);
    }
  }

  getCommands(): ChatCommand[] {
    const commands: ChatCommand[] = [
      ...this.agentModule.getCommands(),
      ...this.askModule.getCommands(),
      ...this.searchModule.getCommands(),
      ...this.voiceModule.getCommands(),
      ...this.systemModule.getCommands(),
      ...this.setupModule.getCommands(),
      ...this.customCommandsModule.getCommands(),
      ...this.shellCommandModule.getCommands(),
      {
        name: "exit",
        description: "Exit the chat",
        handler: this.handleExitCommand.bind(this),
      },
      {
        name: "multi",
        description: "Toggle multiline mode",
        handler: this.handleMultiCommand.bind(this),
      },
    ];
    return commands;
  }

  getModes(): ChatMode[] {
    return [
      ...this.agentModule.getModes(),
      ...this.askModule.getModes(),
      ...this.searchModule.getModes(),
      ...this.voiceModule.getModes(),
      ...this.systemModule.getModes(),
      ...this.setupModule.getModes(),
      ...this.customCommandsModule.getModes(),
      ...this.shellCommandModule.getModes(),
    ];
  }

  async handleExitCommand(args: string[]): Promise<void> {
    console.log("Goodbye!");
    process.exit(0);
  }

  async handleMultiCommand(args: string[]): Promise<void> {
    const context = this.chatService?.getContext();
    const newMultiMode = !context?.multilineMode;
    this.chatService?.setContext({ multilineMode: newMultiMode });
    console.log(`Multiline mode: ${newMultiMode ? "enabled" : "disabled"}`);
  }

  /**
   * Check if input matches a known command without prefix and suggest using the prefix
   */
  private checkForFuzzyCommand(input: string): boolean {
    if (!this.chatService) return false;

    const trimmedInput = input.toLowerCase().trim();
    const availableCommands = this.chatService.getCommands();

    // Check if the input matches any command name exactly (case-insensitive)
    const matchingCommand = availableCommands.find(
      (cmd) =>
        cmd.name.toLowerCase() === trimmedInput ||
        trimmedInput.startsWith(cmd.name.toLowerCase() + " ")
    );

    if (matchingCommand) {
      console.log(
        `Did you mean "/${matchingCommand.name}"? Commands must start with "/"`
      );
      console.log(
        `Available commands: ${availableCommands
          .map((cmd) => `/${cmd.name}`)
          .join(", ")}`
      );
      return true;
    }

    return false;
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    // Check for fuzzy command matches first to prevent agent calls
    // This prevents accidental agent calls when user types commands without "/"
    if (this.checkForFuzzyCommand(input)) {
      return true; // Command suggestion shown, input handled
    }

    // If in agent mode, check if this looks like a command before calling agent
    if (
      context.agentMode &&
      input
        .toLowerCase()
        .match(
          /^(multi|agent|ask|search|voice|system|exit|setup|help|clear)(\s|$)/i
        )
    ) {
      return this.checkForFuzzyCommand(input); // Will show suggestion and return true
    }

    // Try agent module first (handles agent mode)
    if (await this.agentModule.handleInput(input, context)) {
      return true;
    }

    // Try search module
    if (await this.searchModule.handleInput(input, context)) {
      return true;
    }

    // Try voice module
    if (await this.voiceModule.handleInput(input, context)) {
      return true;
    }

    // Default to ask module (handles all non-command input when not in agent mode)
    return await this.askModule.handleInput(input, context);
  }

  async cleanup(): Promise<void> {
    // No cleanup needed
  }
}
