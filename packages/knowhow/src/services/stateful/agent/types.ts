import type { Message, MessageContent } from "../../../clients/types";
import type { BaseControl, InputCursors } from "../types";

export interface AgentTokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

/** The state an AgentSession owns (copied from the BaseAgent on every thread update). */
export interface AgentState {
  agentName: string;
  model: string;
  provider: string;
  reasoningEffort?: string;
  summarizeReasoning?: boolean;
  enabledTools: string[];
  threads: Message[][];
  totalCostUsd: number;
  tokenUsage: AgentTokenUsage;
  prompt: string;
  /** Consumed inputs that are not yet part of the agent's thread. */
  pendingUserMessages: Message[];
  /** Per input channel: fs {inode, offset}, web last row id... */
  inputCursors: InputCursors;
  /** Final answer, once done. */
  result?: string;
}

export interface AgentControl extends BaseControl {
  /** Remotely adjustable budget (USD). */
  maxSpendLimit?: number;
  /** "/compact" from outside. */
  compact?: { id: string };
}

export type AgentEvent =
  | { type: "say"; message: string }
  | { type: "tool_call"; toolCall: any }
  | { type: "tool_result"; toolCall: any; result: string }
  | { type: "usage"; usage: any };

export type AgentPrompt = string | MessageContent[];
