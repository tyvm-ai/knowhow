/**
 * Core Types for Modular Chat System
 */
import { ChatInteraction, Config } from "../types";
import { BaseAgent } from "../agents/base/base";

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
  selectedAgent?: BaseAgent;
  plugins: string[];

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
  formatChatInput(
    input: string,
    plugins: string[],
    chatHistory: ChatInteraction[]
  );
  getInput(
    prompt?: string,
    options?: string[],
    chatHistory?: any[]
  ): Promise<string>;
}

// Enhanced task management types
export interface TaskInfo {
  taskId: string;
  knowhowMessageId?: string;
  knowhowTaskId?: string;
  agentName: string;
  agent: BaseAgent;
  initialInput: string;
  formattedPrompt: string;
  status: "running" | "paused" | "completed" | "failed";
  startTime: number;
  endTime?: number;
  totalCost: number;
  sessionFile?: string;
}

export interface ChatSession {
  knowhowMessageId?: string;
  knowhowTaskId?: string;
  sessionId: string;
  taskId: string;
  agentName: string;
  initialInput: string;
  startTime: number;
  endTime?: number;
  status: "running" | "paused" | "completed" | "failed";
  totalCost: number;
  threads: any[][];
  currentThread: number;
  lastUpdated: number;
}

export interface ChatHistory {
  inputs: string[];
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
