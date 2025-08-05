/**
 * CLI Chat Service - Core service that manages chat context, commands, and modes
 */

import {
  ChatService,
  ChatContext,
  ChatCommand,
  ChatMode,
  InputMethod,
} from "./types.js";
import { ChatHistory } from "./types.js";
import { ask } from "../utils/index.js";
import { ChatModule } from "./types.js";
import { ChatInteraction } from "../types.js";
import { recordAudio, voiceToText } from "../microphone.js";
import editor from "@inquirer/editor";
import fs from "fs";
import path from "path";

export class CliChatService implements ChatService {
  private context: ChatContext;
  private commands: ChatCommand[] = [];
  private modes: ChatMode[] = [];
  private chatHistory: ChatInteraction[] = [];
  private modules: ChatModule[] = [];
  private inputHistory: string[] = [];
  private readonly historyFile = ".knowhow/chats/history.json";

  constructor(plugins: string[] = []) {
    this.context = {
      debugMode: false,
      agentMode: false,
      currentAgent: undefined,
      searchMode: false,
      voiceMode: false,
      multilineMode: false,
      currentModel: "gpt-4o",
      currentProvider: "openai",
      chatHistory: this.chatHistory,
      plugins,
    };
    this.loadInputHistory();
  }

  /**
   * Load input history from disk for scrollback functionality
   */
  private loadInputHistory(): void {
    try {
      if (fs.existsSync(this.historyFile)) {
        const historyData = fs.readFileSync(this.historyFile, "utf8");
        const chatHistory: ChatHistory = JSON.parse(historyData);
        this.inputHistory = chatHistory.inputs || [];
      }
    } catch (error) {
      console.error("Error loading input history:", error);
      this.inputHistory = [];
    }
  }

  /**
   * Save input history to disk
   */
  private saveInputHistory(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const chatHistory: ChatHistory = {
        inputs: this.inputHistory,
      };

      fs.writeFileSync(this.historyFile, JSON.stringify(chatHistory, null, 2));
    } catch (error) {
      console.error("Error saving input history:", error);
    }
  }

  /**
   * Add input to history and persist it
   */
  private addToInputHistory(input: string): void {
    // Don't save commands or empty inputs
    if (!input.startsWith("/") && input.trim() !== "") {
      this.inputHistory.push(input);

      // Keep history size manageable (last 1000 inputs)
      if (this.inputHistory.length > 1000) {
        this.inputHistory = this.inputHistory.slice(-1000);
      }

      this.saveInputHistory();
    }
  }

  getContext(): ChatContext {
    return this.context;
  }

  setContext(context: Partial<ChatContext>): void {
    this.context = { ...this.context, ...context };
    // Keep chatHistory reference synchronized
    if (this.context.chatHistory !== this.chatHistory) {
      this.context.chatHistory = this.chatHistory;
    }
  }

  setInputMethod(method: InputMethod): void {
    this.context.inputMethod = method;
  }

  resetInputMethod(): void {
    delete this.context.inputMethod;
  }

  registerCommand(command: ChatCommand): void {
    this.commands.push(command);
  }

  registerMode(mode: ChatMode): void {
    this.modes.push(mode);
  }

  registerModule(module: ChatModule): void {
    this.modules.push(module);
  }

  getCommands(): ChatCommand[] {
    return this.commands;
  }

  getModes(): ChatMode[] {
    return this.modes;
  }

  getMode(name: string): ChatMode | undefined {
    return this.modes.find((mode) => mode.name === name);
  }

  async processInput(input: string): Promise<boolean> {
    // Add input to history (if not a command)
    this.addToInputHistory(input);

    // Check if input is a command
    if (input.startsWith("/")) {
      const [commandName, ...args] = input.slice(1).split(" ");
      const command = this.commands.find((cmd) => cmd.name === commandName);

      if (command) {
        await command.handler(args);
        return true;
      }
    }

    // If not a command, try delegating to modules
    for (const module of this.modules) {
      try {
        const handled = await module.handleInput(input, this.context);
        if (handled) {
          return true;
        }
      } catch (error) {
        console.error(`Error in module ${module.name}:`, error);
      }
    }

    return false;
  }

  enableMode(name: string): void {
    const mode = this.modes.find((m) => m.name === name);
    if (mode) {
      mode.active = true;
    }
  }

  disableMode(name: string): void {
    const mode = this.modes.find((m) => m.name === name);
    if (mode) {
      mode.active = false;
    }
  }

  async getInput(
    prompt: string = "> ",
    options: string[] = [],
    chatHistory: any[] = []
  ): Promise<string> {
    if (this.context.inputMethod) {
      return await this.context.inputMethod.getInput(prompt);
    }

    let value = "";
    if (this.context.voiceMode) {
      value = await voiceToText();
    } else if (this.context.multilineMode) {
      value = await editor({ message: prompt });
      this.context.multilineMode = false; // Disable after use like original
    } else {
      // Use saved input history for scrollback instead of current chat history
      const history = this.inputHistory.slice().reverse();
      value = await ask(prompt, options, history);
    }

    return value.trim();
  }

  clearHistory(): void {
    this.chatHistory = [];
    this.context.chatHistory = this.chatHistory;
  }

  getChatHistory(): ChatInteraction[] {
    return this.chatHistory;
  }

  /**
   * Get input history for external access
   */
  getInputHistory(): string[] {
    return [...this.inputHistory];
  }

  /**
   * Clear input history
   */
  clearInputHistory(): void {
    this.inputHistory = [];
    this.saveInputHistory();
  }

  async startChatLoop(): Promise<void> {
    // Display available commands like the original
    const commandNames = this.commands.map((cmd) => `/${cmd.name}`);
    console.log("Commands: ", commandNames.join(", "));

    while (true) {
      const promptText =
        this.context.agentMode && this.context.currentAgent
          ? `\nAsk knowhow ${this.context.currentAgent}: `
          : `\nAsk knowhow: `;
      try {
        // Pass command names as autocomplete options
        const input = await this.getInput(
          promptText,
          commandNames,
          this.chatHistory
        );

        if (input.trim() === "") {
          continue;
        }

        // Process the input
        const handled = await this.processInput(input.trim());

        if (!handled) {
          // Default chat behavior - this would be handled by a chat module
          const interaction = {
            input,
            output: `I didn't understand that command. Available commands: ${commandNames.join(
              ", "
            )}`,
          } as ChatInteraction;
          this.chatHistory.push(interaction);
          console.log(interaction.output);
        }
      } catch (error) {
        console.error("Error in chat loop:", error);
      }
    }
  }
}
