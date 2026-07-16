/**
 * PlainRenderer - A plain-text, append-only renderer for non-TTY environments.
 *
 * Used automatically when stdout is not a TTY (e.g. redirected to a file,
 * piped, or run in background). Emits simple timestamped log lines with no
 * ANSI codes, no cursor movement, and no spinner — safe for logfiles.
 *
 * Activate explicitly via:
 *   knowhow agent --renderer plain ...
 * or it is selected automatically when !process.stdout.isTTY and no renderer
 * is configured.
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

function ts(): string {
  return new Date().toISOString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatArgs(raw: string): string {
  try {
    const obj = JSON.parse(raw || "{}");
    const entries = Object.entries(obj);
    if (!entries.length) return "{}";
    return entries
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}=${truncate(val, 80)}`;
      })
      .join(", ");
  } catch {
    return truncate(raw || "", 120);
  }
}

function formatResult(result: any): string {
  try {
    const s = typeof result === "string" ? result : JSON.stringify(result);
    return truncate(s.replace(/\s+/g, " "), 200);
  } catch {
    return truncate(String(result), 200);
  }
}

export class PlainRenderer implements AgentRenderer {
  private activeTaskId: string | undefined;
  private emitter = new EventEmitter();
  private paused = false;
  private bufferedEvents: RenderEvent[] = [];

  setActiveTaskId(taskId: string | undefined): void {
    this.activeTaskId = taskId;
  }

  getActiveTaskId(): string | undefined {
    return this.activeTaskId;
  }

  private isActiveTask(taskId: string): boolean {
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

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const buffered = this.bufferedEvents.splice(0);
    for (const event of buffered) {
      this.render(event);
    }
  }

  render(event: RenderEvent): void {
    if (!this.isActiveTask(event.taskId)) return;

    if (this.paused) {
      this.bufferedEvents.push(event);
      return;
    }

    this.emitter.emit(event.type, event);

    switch (event.type) {
      case "log":
        this._log(event);
        break;
      case "agentStatus":
        this._status(event);
        break;
      case "toolCall":
        this._toolCall(event);
        break;
      case "toolResult":
        this._toolResult(event);
        break;
      case "agentMessage":
        this._message(event);
        break;
      case "agentDone":
        this._done(event);
        break;
    }
  }

  private _write(line: string): void {
    process.stdout.write(line + "\n");
  }

  private _log(e: LogEvent): void {
    const level = e.level.toUpperCase().padEnd(5);
    this._write(`${ts()} [${level}] [${e.agentName}] ${e.message}`);
  }

  private _status(e: AgentStatusEvent): void {
    const cost = `$${e.details.totalCostUsd.toFixed(3)}`;
    const elapsed = `${Math.floor(e.details.elapsedMs / 1000)}s`;
    const parts = [`cost=${cost}`, `elapsed=${elapsed}`];
    if (e.details.remainingTurns !== undefined) {
      parts.push(`turns_left=${e.details.remainingTurns}`);
    }
    if (e.details.remainingTimeMs !== undefined) {
      parts.push(`time_left=${Math.floor(e.details.remainingTimeMs / 1000)}s`);
    }
    this._write(
      `${ts()} [STATUS] [${e.agentName}] ${e.statusMessage} | ${parts.join(" | ")}`
    );
  }

  private _toolCall(e: ToolCallEvent): void {
    const args = formatArgs(e.toolCall.function.arguments);
    this._write(
      `${ts()} [TOOL->] [${e.agentName}] ${e.toolCall.function.name}(${args})`
    );
  }

  private _toolResult(e: ToolResultEvent): void {
    const result = formatResult(e.result);
    this._write(
      `${ts()} [TOOL<-] [${e.agentName}] ${e.toolCall.function.name} => ${result}`
    );
  }

  private _message(e: AgentMessageEvent): void {
    if (e.role !== "assistant") return;
    // Print the message with line-by-line prefix
    const lines = e.message.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        this._write(`${ts()} [MSG  ] [${e.agentName}] ${line}`);
      }
    }
  }

  private _done(e: AgentDoneEvent): void {
    const cost = e.totalCost ? ` | total_cost=$${e.totalCost.toFixed(4)}` : "";
    this._write(`${ts()} [DONE ] [${e.agentName}] Agent finished${cost}`);
    // Print final output lines
    const lines = e.output.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        this._write(`${ts()} [OUT  ] [${e.agentName}] ${line}`);
      }
    }
  }

  logMessages(events: RenderEvent[], count: number = 20): void {
    const recent = events.slice(-count);
    this._write(`\n[LOGS ] Last ${recent.length} events:`);
    this._write("-".repeat(80));
    for (const event of recent) {
      this.render(event);
    }
    this._write("-".repeat(80));
  }
}

export default PlainRenderer;
