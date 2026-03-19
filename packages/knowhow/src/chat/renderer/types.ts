/**
 * Renderer interfaces for CLI agent output
 */

export interface LogEvent {
  taskId: string;
  agentName: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: number;
}

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallEvent {
  taskId: string;
  agentName: string;
  toolCall: ToolCall;
}

export interface ToolResultEvent {
  taskId: string;
  agentName: string;
  toolCall: ToolCall;
  result: any;
}

export interface AgentMessageEvent {
  taskId: string;
  agentName: string;
  message: string;
  role: "assistant" | "user";
}

export interface AgentDoneEvent {
  taskId: string;
  agentName: string;
  output: string;
  totalCost: number;
}

export interface AgentStatusEvent {
  taskId: string;
  agentName: string;
  statusMessage: string;
  details: {
    totalCostUsd: number;
    elapsedMs: number;
    remainingTimeMs?: number;
    remainingTurns?: number;
    remainingBudget?: number;
  };
  timestamp: number;
}

export type RenderEvent =
  | ({ type: "log" } & LogEvent)
  | ({ type: "agentStatus" } & AgentStatusEvent)
  | ({ type: "toolCall" } & ToolCallEvent)
  | ({ type: "toolResult" } & ToolResultEvent)
  | ({ type: "agentMessage" } & AgentMessageEvent)
  | ({ type: "agentDone" } & AgentDoneEvent);

export interface AgentRenderer {
  onLog(handler: (event: LogEvent) => void): void;
  onAgentStatus(handler: (event: AgentStatusEvent) => void): void;
  onToolCall(handler: (event: ToolCallEvent) => void): void;
  onToolResult(handler: (event: ToolResultEvent) => void): void;
  onAgentMessage(handler: (event: AgentMessageEvent) => void): void;
  onAgentDone(handler: (event: AgentDoneEvent) => void): void;
  render(event: RenderEvent): void;

  /** Set the currently active agent task ID - only events for this task are shown */
  setActiveTaskId(taskId: string | undefined): void;
  getActiveTaskId(): string | undefined;

  /**
   * Replay the last N render events (used by /logs command).
   * If count is not provided, shows last 10.
   */
  logMessages(events: RenderEvent[], count?: number): void;
}
