import { ChatModule } from "../types";
import { CliChatService } from "../CliChatService";
import { AgentModule } from "./AgentModule";
import { ChatCommand, ChatMode, ChatContext } from "../types";
import { AskModule } from "./AskModule";
import { SearchModule } from "./SearchModule";
import { VoiceModule } from "./VoiceModule";
import { SystemModule } from "./SystemModule";

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
    
    // Register our own commands (exit and multi) - not duplicated by BaseChatModule
    chatService.registerCommand({
      name: 'exit',
      description: 'Exit the chat',
      handler: this.handleExitCommand.bind(this)
    });
    
    chatService.registerCommand({
      name: 'multi',
      description: 'Toggle multiline mode',
      handler: this.handleMultiCommand.bind(this)
    });
  }

  getCommands(): ChatCommand[] {
    const commands: ChatCommand[] = [
      ...this.agentModule.getCommands(),
      ...this.askModule.getCommands(),
      ...this.searchModule.getCommands(),
      ...this.voiceModule.getCommands(),
      ...this.systemModule.getCommands(),
      {
        name: 'exit',
        description: 'Exit the chat',
        handler: this.handleExitCommand.bind(this)
      },
      {
        name: 'multi',
        description: 'Toggle multiline mode',
        handler: this.handleMultiCommand.bind(this)
      }
    ];
    return commands;
  }

  getModes(): ChatMode[] {
    return [
      ...this.agentModule.getModes(),
      ...this.askModule.getModes(),
      ...this.searchModule.getModes(),
      ...this.voiceModule.getModes(),
      ...this.systemModule.getModes()
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
    console.log(`Multiline mode: ${newMultiMode ? 'enabled' : 'disabled'}`);
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    // Delegate input to appropriate modules based on context and input
    
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