/**
 * Base Chat Module - Abstract base class for all chat modules
 */

import { ChatModule, ChatService, ChatCommand, ChatMode, ChatContext } from '../types.js';

export abstract class BaseChatModule implements ChatModule {
  public abstract name: string;
  public abstract description: string;
  public commands: ChatCommand[] = [];
  public modes: ChatMode[] = [];
  
  protected chatService!: ChatService;

  async initialize(service: ChatService): Promise<void> {
    this.chatService = service;
    this.commands = this.getCommands();
    this.modes = this.getModes();
    
    // Register all commands with the ChatService
    for (const command of this.commands) {
      this.chatService.registerCommand(command);
    }
  }

  /**
   * Override this method to provide commands
   */
  public getCommands(): ChatCommand[] {
    return [];
  }

  /**
   * Override this method to provide modes
   */
  public getModes(): ChatMode[] {
    return [];
  }

  /**
   * Override this method to handle non-command input
   */
  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    return false; // Default: don't handle input
  }

  /**
   * Override this method for cleanup
   */
  async cleanup(): Promise<void> {
    // Default: no cleanup needed
  }

  /**
   * Helper method to update context
   */
  protected updateContext(updates: Partial<ChatContext>): void {
    this.chatService.setContext(updates);
  }
}