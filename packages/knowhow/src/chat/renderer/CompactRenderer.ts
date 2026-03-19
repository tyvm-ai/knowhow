/**
 * CompactRenderer - A minimal, dense renderer for knowhow chat.
 * Great for smaller terminals or when you want less visual noise.
 *
 * Activate via config:
 *   { "chat": { "renderer": "compact" } }
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

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
};

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatArgs(raw: string): string {
  try {
    const obj = JSON.parse(raw || "{}");
    const entries = Object.entries(obj);
    if (!entries.length) return "{}";
    if (entries.length === 1) {
      const [k, v] = entries[0];
      return `${k}=${truncate(JSON.stringify(v), 60)}`;
    }
    return entries
      .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 40)}`)
      .join(", ");
  } catch {
    return truncate(raw, 80);
  }
}

const timers = new Map<string, number>();
const agentPalette = [
  "\x1b[96m",
  "\x1b[95m",
  "\x1b[92m",
  "\x1b[93m",
  "\x1b[94m",
];
const agentColors = new Map<string, string>();
let pi = 0;
function colorFor(n: string) {
  if (!agentColors.has(n))
    agentColors.set(n, agentPalette[pi++ % agentPalette.length]);
  return agentColors.get(n)!;
}

export class CompactRenderer implements AgentRenderer {
  private activeTaskId: string | undefined;
  private emitter = new EventEmitter();

  setActiveTaskId(id: string | undefined): void {
    this.activeTaskId = id;
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

  render(event: RenderEvent): void {
    if (!this.isActiveTask(event.taskId)) return;
    this.emitter.emit(event.type, event);
    switch (event.type) {
      case "log":
        return this._log(event as LogEvent);
      case "agentStatus":
        return this._status(event as AgentStatusEvent);
      case "toolCall":
        return this._toolCall(event as ToolCallEvent);
      case "toolResult":
        return this._toolResult(event as ToolResultEvent);
      case "agentMessage":
        return this._message(event as AgentMessageEvent);
      case "agentDone":
        return this._done(event as AgentDoneEvent);
    }
  }

  private _log(e: LogEvent): void {
    const tag =
      { info: c.cyan + "i", warn: c.yellow + "!", error: c.red + "✗" }[
        e.level
      ] ?? c.gray + "·";
    process.stdout.write(`${tag}${c.reset} ${c.dim}${e.message}${c.reset}\n`);
  }

  private _status(e: AgentStatusEvent): void {
    const col = colorFor(e.agentName);
    const cost = `${c.brightGreen}$${e.details.totalCostUsd.toFixed(3)}${c.reset}`;
    const elapsed = `${Math.floor(e.details.elapsedMs / 1000)}s`;
    process.stdout.write(
      `${c.dim}●${c.reset} ${col}${e.agentName}${c.reset} ${cost} ${elapsed}\n`
    );
  }

  private _toolCall(e: ToolCallEvent): void {
    timers.set(`${e.taskId}:${e.toolCall.function.name}`, Date.now());
    const col = colorFor(e.agentName);
    const args = formatArgs(e.toolCall.function.arguments);
    process.stdout.write(
      `${c.dim}▶${c.reset} ${col}${c.bold}${e.toolCall.function.name}${c.reset} ${c.dim}(${args})${c.reset}\n`
    );
  }

  private _toolResult(e: ToolResultEvent): void {
    const name = e.toolCall.function.name;
    const start = timers.get(`${e.taskId}:${name}`);
    const ms = start ? `${Date.now() - start}ms` : "";
    timers.delete(`${e.taskId}:${name}`);

    let preview: string;
    try {
      const s =
        typeof e.result === "string" ? e.result : JSON.stringify(e.result);
      preview = truncate(s.replace(/\s+/g, " "), 120);
    } catch {
      preview = String(e.result).slice(0, 120);
    }

    process.stdout.write(
      `  ${c.brightGreen}✓${c.reset} ${c.dim}${ms}${c.reset} ${c.dim}${preview}${c.reset}\n`
    );
  }

  private _message(e: AgentMessageEvent): void {
    if (e.role !== "assistant") return;
    const col = colorFor(e.agentName);
    const lines = e.message.split("\n");
    const first = lines[0] ?? "";
    process.stdout.write(`\n${col}${c.bold}${e.agentName}${c.reset} ${first}\n`);
    for (const l of lines.slice(1)) {
      if (l.trim()) process.stdout.write(`  ${l}\n`);
    }
  }

  private _done(e: AgentDoneEvent): void {
    const col = colorFor(e.agentName);
    const cost = e.totalCost
      ? ` ${c.brightGreen}$${e.totalCost.toFixed(4)}${c.reset}`
      : "";
    process.stdout.write(`\n${col}✔ ${e.agentName}${c.reset}${cost}\n\n`);
  }

  logMessages(events: RenderEvent[], count: number = 10): void {
    const recent = events.slice(-count);
    process.stdout.write(`\n[logs] Last ${recent.length} messages:\n`);
    process.stdout.write("-".repeat(60) + "\n");
    for (const event of recent) {
      this.render(event);
    }
    process.stdout.write("-".repeat(60) + "\n");
  }

}

export default CompactRenderer;
