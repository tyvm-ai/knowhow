/**
 * ConsoleRenderer - Default renderer that outputs to console
 * Implements AgentRenderer interface with standard console.log behavior
 */
import {
  AgentRenderer,
  LogEvent,
  AgentStatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  AgentMessageEvent,
  AgentDoneEvent,
  RenderEvent,
} from "./types";
import { EventEmitter } from "events";

export class ConsoleRenderer implements AgentRenderer {
  private activeTaskId: string | undefined;
  private emitter = new EventEmitter();

  setActiveTaskId(taskId: string | undefined): void {
    this.activeTaskId = taskId;
  }

  getActiveTaskId(): string | undefined {
    return this.activeTaskId;
  }

  private isActiveTask(taskId: string): boolean {
    // If no active task is set, show all events
    if (!this.activeTaskId) return true;
    return taskId === this.activeTaskId;
  }

  onLog(handler: (event: LogEvent) => void): void {
    this.emitter.on("log", handler);
  }

  onAgentStatus(handler: (event: AgentStatusEvent) => void): void {
    this.emitter.on("agentStatus", handler);
  }

  onToolCall(handler: (event: ToolCallEvent) => void): void {
    this.emitter.on("toolCall", handler);
  }

  onToolResult(handler: (event: ToolResultEvent) => void): void {
    this.emitter.on("toolResult", handler);
  }

  onAgentMessage(handler: (event: AgentMessageEvent) => void): void {
    this.emitter.on("agentMessage", handler);
  }

  onAgentDone(handler: (event: AgentDoneEvent) => void): void {
    this.emitter.on("agentDone", handler);
  }

  render(event: RenderEvent): void {
    if (!this.isActiveTask(event.taskId)) return;

    switch (event.type) {
      case "log":
        this.emitter.emit("log", event);
        this.renderLog(event);
        break;
      case "agentStatus":
        this.emitter.emit("agentStatus", event);
        this.renderAgentStatus(event);
        break;
      case "toolCall":
        this.emitter.emit("toolCall", event);
        this.renderToolCall(event);
        break;
      case "toolResult":
        this.emitter.emit("toolResult", event);
        this.renderToolResult(event);
        break;
      case "agentMessage":
        this.emitter.emit("agentMessage", event);
        this.renderAgentMessage(event);
        break;
      case "agentDone":
        this.emitter.emit("agentDone", event);
        this.renderAgentDone(event);
        break;
    }
  }

  logMessages(events: RenderEvent[], count: number = 20): void {
    const recent = events.slice(-count);
    console.log(`\n📜 Last ${recent.length} messages:`);
    console.log("─".repeat(60));
    for (const event of recent) {
      this.render(event);
    }
    console.log("─".repeat(60));
  }

  private renderLog(event: LogEvent): void {
    switch (event.level) {
      case "warn":
        console.warn(event.message);
        break;
      case "error":
        console.error(event.message);
        break;
      default:
        console.log(event.message);
    }
  }

  private renderAgentStatus(event: AgentStatusEvent): void {
    console.log(`\n● ${event.agentName} status: ${event.statusMessage}`);
  }

  private renderToolCall(event: ToolCallEvent): void {
    console.time(JSON.stringify(event.toolCall.function.name));
    console.log(
      ` 🔨 Tool: ${event.toolCall.function.name}\n Args: ${event.toolCall.function.arguments}\n`
    );
  }

  private renderToolResult(event: ToolResultEvent): void {
    console.timeEnd(JSON.stringify(event.toolCall.function.name));
    console.log(
      ` 🔨 Tool Response:\n              ${JSON.stringify(event.result, null, 2)}`
    );
  }

  private renderAgentMessage(event: AgentMessageEvent): void {
    console.log(`[${event.agentName}]: ${event.message}`);
  }

  private renderAgentDone(event: AgentDoneEvent): void {
    console.log(`🎯 Agent Done: ${event.agentName}`);
    if (event.totalCost) {
      console.log(`💰 Total cost: $${event.totalCost.toFixed(4)}`);
    }
  }
}
