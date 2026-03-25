/**
 * FancyRenderer - A visually rich terminal renderer using box-drawing characters and ANSI colors.
 *
 * Features:
 * - Colored agent messages with agent name badges
 * - Tool calls displayed in bordered boxes
 * - Tool results with syntax-aware truncation
 * - Timing displayed inline
 * - Cost/status line with spinner animation
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

// ANSI color/style codes
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgWhite: "\x1b[47m",
  bgGray: "\x1b[100m",

  brightBlue: "\x1b[94m",
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightMagenta: "\x1b[95m",
  brightWhite: "\x1b[97m",
};

// Box drawing characters
const box = {
  tl: "╭", tr: "╮",
  bl: "╰", br: "╯",
  h: "─", v: "│",
  ml: "├", mr: "┤",
  cross: "┼",
};

const toolBox = {
  tl: "┌", tr: "┐",
  bl: "└", br: "┘",
  h: "─", v: "│",
  ml: "├", mr: "┤",
};

// Terminal width helper
function termWidth(): number {
  return process.stdout.columns || 80;
}

function pad(str: string, len: number, char = " "): string {
  while (str.length < len) str += char;
  return str;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(str: string): string {
  return stripAnsi(str);
}

/** Draw a horizontal rule with optional label */
function hRule(label = "", color = c.gray, width = termWidth()): string {
  if (!label) {
    return color + box.h.repeat(width) + c.reset;
  }
  const labelStr = ` ${label} `;
  const side = Math.floor((width - labelStr.length) / 2);
  const left = box.h.repeat(Math.max(0, side));
  const right = box.h.repeat(Math.max(0, width - side - labelStr.length));
  return color + left + c.reset + c.bold + color + labelStr + c.reset + color + right + c.reset;
}

/** Draw a box around content lines */
function drawBox(
  lines: string[],
  headerLabel: string,
  headerColor: string,
  width: number
): string {
  const innerWidth = width - 2;
  const headerText = ` ${headerLabel} `;
  const headerPad = Math.max(0, innerWidth - stripAnsi(headerText).length);
  const topLine =
    headerColor + toolBox.tl + toolBox.h +
    c.bold + headerColor + headerText + c.reset +
    headerColor + toolBox.h.repeat(headerPad) +
    toolBox.tr + c.reset;

  const contentLines = lines.map((line) => {
    const visible = stripAnsi(line);
    const padLen = Math.max(0, innerWidth - visible.length);
    return headerColor + toolBox.v + c.reset + " " + line + " ".repeat(padLen - 1) + headerColor + toolBox.v + c.reset;
  });

  const bottomLine = headerColor + toolBox.bl + toolBox.h.repeat(innerWidth) + toolBox.br + c.reset;

  return [topLine, ...contentLines, bottomLine].join("\n");
}

/** Format JSON for display, with line limit */
function formatResult(result: any, maxLines = 20): string[] {
  let str: string;
  try {
    str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch {
    str = String(result);
  }

  const lines = str.split("\n");
  if (lines.length <= maxLines) return lines;

  const head = lines.slice(0, Math.floor(maxLines * 0.7));
  const tail = lines.slice(lines.length - Math.floor(maxLines * 0.2));
  const omitted = lines.length - head.length - tail.length;
  return [
    ...head,
    c.dim + `  ... (${omitted} lines omitted) ...` + c.reset,
    ...tail,
  ];
}

/** Colorize JSON string with basic syntax highlighting */
function colorizeJson(lines: string[]): string[] {
  return lines.map((line) => {
    // Already has ansi (dim omitted line)
    if (line.includes("\x1b[")) return line;

    return line
      // Keys
      .replace(/"([^"]+)":/g, `${c.cyan}"$1"${c.reset}:`)
      // String values
      .replace(/: "([^"]*)"/g, `: ${c.brightGreen}"$1"${c.reset}`)
      // Numbers
      .replace(/: (-?\d+\.?\d*)/g, `: ${c.brightYellow}$1${c.reset}`)
      // Booleans
      .replace(/: (true|false)/g, `: ${c.brightMagenta}$1${c.reset}`)
      // Null
      .replace(/: null/g, `: ${c.dim}null${c.reset}`);
  });
}

/** Agent name → deterministic color */
const agentColors = [c.brightCyan, c.brightMagenta, c.brightGreen, c.brightYellow, c.brightBlue];
const agentColorMap = new Map<string, string>();
let agentColorIdx = 0;
function agentColor(name: string): string {
  if (!agentColorMap.has(name)) {
    agentColorMap.set(name, agentColors[agentColorIdx++ % agentColors.length]);
  }
  return agentColorMap.get(name)!;
}

/** Keep track of tool call start times */
const toolTimers = new Map<string, number>();

export class FancyRenderer implements AgentRenderer {
  private activeTaskId: string | undefined;
  private emitter = new EventEmitter();

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

  private renderLog(event: LogEvent): void {
    const width = termWidth();
    const levelColors: Record<string, string> = {
      info: c.brightBlue,
      warn: c.brightYellow,
      error: c.red,
    };
    const icons: Record<string, string> = {
      info: "ℹ",
      warn: "⚠",
      error: "✖",
    };
    const col = levelColors[event.level] || c.gray;
    const icon = icons[event.level] || "·";
    const prefix = col + icon + c.reset + " " + c.dim + `[${event.agentName}]` + c.reset + " ";
    const msg = event.message;
    console.log(prefix + msg);
  }

  private renderAgentStatus(event: AgentStatusEvent): void {
    const agentCol = agentColor(event.agentName);
    const cost = c.brightGreen + `$${event.details.totalCostUsd.toFixed(3)}` + c.reset;
    const elapsed = c.brightYellow + `${Math.floor(event.details.elapsedMs / 1000)}s` + c.reset;
    
    let extras = "";
    if (event.details.remainingTimeMs !== undefined) {
      extras += c.dim + ` ~${Math.floor(event.details.remainingTimeMs / 1000)}s left` + c.reset;
    }
    if (event.details.remainingTurns !== undefined) {
      extras += c.dim + ` ${event.details.remainingTurns} turns` + c.reset;
    }

    const badge = `${c.dim}●${c.reset} ${agentCol}${event.agentName}${c.reset}`;
    console.log(`\n${badge} ${cost} ${elapsed}${extras}`);
  }

  private renderToolCall(event: ToolCallEvent): void {
    const width = termWidth();
    const toolName = event.toolCall.function.name;
    const timerKey = `${event.taskId}:${toolName}:${Date.now()}`;
    // Store start time under a stable key (last one wins per tool name per task)
    toolTimers.set(`${event.taskId}:${toolName}`, Date.now());

    let args: any;
    try {
      args = JSON.parse(event.toolCall.function.arguments || "{}");
    } catch {
      args = event.toolCall.function.arguments;
    }

    const agentCol = agentColor(event.agentName);
    const headerLabel = `⚡ ${c.bold}${toolName}${c.reset}${c.brightYellow}`;

    // Format args
    const argsLines = colorizeJson(formatResult(args, 10));

    const boxStr = drawBox(argsLines, `⚡ ${toolName}`, c.brightYellow, Math.min(width, 100));
    console.log("");
    console.log(
      c.dim + agentCol + `[${event.agentName}]` + c.reset +
      c.dim + " called tool:" + c.reset
    );
    console.log(boxStr);
  }

  private renderToolResult(event: ToolResultEvent): void {
    const width = termWidth();
    const toolName = event.toolCall.function.name;

    // Calculate elapsed time
    const startTime = toolTimers.get(`${event.taskId}:${toolName}`);
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(3) + "s" : "";
    toolTimers.delete(`${event.taskId}:${toolName}`);

    const resultLines = colorizeJson(formatResult(event.result, 25));
    const elapsedStr = elapsed ? c.dim + ` ⏱ ${elapsed}` + c.reset : "";
    const headerLabel = `✓ ${toolName}${elapsedStr}`;

    const boxStr = drawBox(resultLines, `✓ ${toolName} ${elapsed}`, c.brightGreen, Math.min(width, 100));
    console.log(boxStr);
  }

  private renderAgentMessage(event: AgentMessageEvent): void {
    const width = termWidth();
    const agentCol = agentColor(event.agentName);

    if (event.role === "assistant") {
      // Decorative separator with agent badge
      const badge = ` ${agentCol}${c.bold} ${event.agentName} ${c.reset} `;
      const badgeLen = stripAnsi(badge).length;
      const lineLen = Math.min(width, 80);
      const leftPad = 2;
      const rightPad = Math.max(0, lineLen - leftPad - badgeLen);

      const separator =
        c.gray + box.tl + box.h.repeat(leftPad) + c.reset +
        badge +
        c.gray + box.h.repeat(rightPad) + box.tr + c.reset;

      console.log("\n" + separator);

      // Word-wrap the message at width - 4
      const wrapWidth = Math.min(width - 4, 76);
      const words = event.message.split(" ");
      const wrappedLines: string[] = [];
      let currentLine = "";

      for (const word of words) {
        if (currentLine.length + word.length + 1 > wrapWidth) {
          if (currentLine) wrappedLines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = currentLine ? currentLine + " " + word : word;
        }
      }
      if (currentLine) wrappedLines.push(currentLine);

      for (const line of wrappedLines) {
        console.log(c.gray + box.v + c.reset + "  " + c.brightWhite + line + c.reset);
      }

      const bottomSep = c.gray + box.bl + box.h.repeat(lineLen - 2) + box.br + c.reset;
      console.log(bottomSep);
    } else {
      // User message (less common to render, but support it)
      console.log(c.dim + "  › " + c.reset + event.message);
    }
  }

  private renderAgentDone(event: AgentDoneEvent): void {
    const width = termWidth();
    const agentCol = agentColor(event.agentName);

    const costStr = event.totalCost
      ? c.brightGreen + `$${event.totalCost.toFixed(4)}` + c.reset
      : "";

    const label = ` ${agentCol}${c.bold}✔ ${event.agentName} done${c.reset}${costStr ? "  " + costStr : ""} `;
    console.log("\n" + hRule(stripAnsi(label), agentCol, Math.min(width, 80)));
    if (event.totalCost) {
      console.log(
        c.dim + "  Total cost: " + c.reset +
        c.brightGreen + `$${event.totalCost.toFixed(4)}` + c.reset
      );
    }
    console.log("");
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

export default FancyRenderer;
