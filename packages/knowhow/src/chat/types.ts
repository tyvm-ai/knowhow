/**
 * Core Types for Modular Chat System
 */

export interface ChatContext {
  debugMode?: boolean;
  agentMode?: boolean;
  currentAgent?: string;
  searchMode?: boolean;
  voiceMode?: boolean;
  multilineMode?: boolean;
  currentModel?: string;
  currentProvider?: string;
  inputMethod?: InputMethod;
  [key: string]: any;
}

export interface ChatMode {
  name: string;
  description: string;
  active: boolean;
}

export interface ChatCommand {
  name: string;
  description: string;
  handler: (args: string[]) => Promise<void>;
}

export interface InputMethod {
  name: string;
  description: string;
  getInput: (prompt?: string) => Promise<string>;
}

export interface ChatService {
  getContext(): ChatContext;
  setContext(context: Partial<ChatContext>): void;
  setInputMethod(method: InputMethod): void;
  resetInputMethod(): void;
  registerCommand(command: ChatCommand): void;
  registerMode(mode: ChatMode): void;
  getCommands(): ChatCommand[];
  getModes(): ChatMode[];
  getMode(name: string): ChatMode | undefined;
  enableMode(name: string): void;
  disableMode(name: string): void;
  processInput(input: string): Promise<boolean>;
  getInput(prompt?: string, options?: string[], chatHistory?: any[]): Promise<string>;
}

export interface ChatModule {
  name: string;
  description: string;
  commands: ChatCommand[];
  modes: ChatMode[];
  
  initialize(service: ChatService): Promise<void>;
  handleInput(input: string, context: ChatContext): Promise<boolean>;
  cleanup(): Promise<void>;
}