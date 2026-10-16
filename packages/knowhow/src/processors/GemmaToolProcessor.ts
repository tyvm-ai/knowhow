import { Message, ToolCall } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";

/**
 * Gemma 4 Tool Call Processor
 *
 * Gemma 4 uses a non-standard tool-call format with its own string-quoting token:
 *
 *   <|tool_call>call:toolName{key:<|"|>string value<|"|>,numKey:42,boolKey:true}<tool_call|>
 *
 * Strings are delimited by <|"|> instead of standard JSON quotes.
 * Numbers and booleans are written bare (no quotes).
 * Multiple tool calls may appear in a single assistant message.
 *
 * Reference: https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
 */
export class GemmaToolProcessor {
  private static instance: GemmaToolProcessor;

  static getInstance(): GemmaToolProcessor {
    if (!GemmaToolProcessor.instance) {
      GemmaToolProcessor.instance = new GemmaToolProcessor();
    }
    return GemmaToolProcessor.instance;
  }

  // ── Detection ─────────────────────────────────────────────────────────────

  /** Returns true when the content looks like it contains Gemma tool-call tokens. */
  private isGemmaFormat(content: string): boolean {
    return content.includes("<|tool_call>") && content.includes("<tool_call|>");
  }

  // ── Parsing ───────────────────────────────────────────────────────────────

  /**
   * Cast a raw argument value string to a JS primitive.
   * Mirrors the Python `cast()` helper from the official docs.
   */
  private castValue(raw: string): string | number | boolean {
    const trimmed = raw.trim();

    // Boolean
    const lower = trimmed.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;

    // Integer
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);

    // Float
    if (/^-?\d+\.\d*$/.test(trimmed)) return parseFloat(trimmed);

    // Strip surrounding single/double quotes that the model might emit
    return trimmed.replace(/^['"]|['"]$/g, "");
  }

  /**
   * Parse the argument body of a single Gemma tool call.
   *
   * The body looks like:
   *   key1:<|"|>string value<|"|>,key2:42,key3:true
   *
   * The regex (from the official docs) handles both quoted strings and bare values:
   *   (\w+):(?:<|"|>(.*?)<|"|>|([^,}]*))
   */
  private parseArgs(argsBody: string): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};

    // Regex from the official Google Gemma 4 function-calling docs
    const argPattern = /(\w+):(?:<\|"\|>(.*?)<\|"\|>|([^,}]*))/gs;
    let m: RegExpExecArray | null;

    while ((m = argPattern.exec(argsBody)) !== null) {
      const key = m[1];
      // v1: string inside <|"|>…<|"|>   v2: bare value
      const rawValue = m[2] !== undefined ? m[2] : m[3] ?? "";
      result[key] = m[2] !== undefined ? rawValue : this.castValue(rawValue);
    }

    return result;
  }

  /**
   * Extract all Gemma tool calls from an assistant message string.
   * Returns an array of { toolName, arguments } objects.
   */
  private extractGemmaToolCalls(
    content: string
  ): { toolName: string; arguments: string }[] {
    const results: { toolName: string; arguments: string }[] = [];

    // Outer pattern: <|tool_call>call:name{args}<tool_call|>
    // Using DOTALL-equivalent workaround: [\s\S] for multi-line args
    const outerPattern = /<\|tool_call>call:(\w+)\{([\s\S]*?)\}<tool_call\|>/g;
    let match: RegExpExecArray | null;

    while ((match = outerPattern.exec(content)) !== null) {
      const toolName = match[1];
      const argsBody = match[2];

      const parsed = this.parseArgs(argsBody);
      results.push({
        toolName,
        arguments: JSON.stringify(parsed),
      });
    }

    return results;
  }

  // ── Conversion ────────────────────────────────────────────────────────────

  private generateToolCallId(): string {
    return `gemma_call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private toToolCalls(
    extracted: { toolName: string; arguments: string }[]
  ): ToolCall[] {
    return extracted.map(({ toolName, arguments: args }) => ({
      id: this.generateToolCallId(),
      type: "function" as const,
      function: {
        name: toolName,
        arguments: args,
      },
    }));
  }

  // ── Message processing ────────────────────────────────────────────────────

  private processMessage(message: Message): void {
    if (message.role !== "assistant") return;
    if (typeof message.content !== "string") return;
    if (message?.tool_calls?.length) return;

    if (!this.isGemmaFormat(message.content)) return;

    const extracted = this.extractGemmaToolCalls(message.content);
    if (extracted.length === 0) return;

    const toolCalls = this.toToolCalls(extracted);

    if (message.tool_calls) {
      message.tool_calls.push(...toolCalls);
    } else {
      message.tool_calls = toolCalls;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  createProcessor(): MessageProcessorFunction {
    return (_originalMessages: Message[], modifiedMessages: Message[]): void => {
      for (const message of modifiedMessages) {
        this.processMessage(message);
      }
    };
  }
}

export const globalGemmaToolProcessor = new GemmaToolProcessor();
