import { Message, ToolCall } from "../clients/types";
import { MessageProcessorFunction } from "../services/MessageProcessor";

/**
 * MinimalToolsMessageProcessor
 *
 * Works with MinimalToolsService to unwrap `callTool(name, args)` invocations
 * in the message history, rewriting them as if the real tool had been called
 * directly.
 *
 * This is registered on the `pre_tools` lifecycle so it runs right before tool
 * calls are dispatched. It rewrites the last assistant message's tool_calls so
 * that:
 *   callTool({ name: "readFile", args: { filePath: "..." } })
 * becomes:
 *   readFile({ filePath: "..." })
 *
 * This means:
 * 1. The `tools:` array sent to the AI never needs to change (cache stable).
 * 2. The agent terminates correctly when callTool("finalAnswer", ...) is called,
 *    because after transformation the required tool name matches.
 * 3. The conversation history looks clean — the model sees native tool calls in
 *    subsequent turns rather than nested callTool wrappers.
 */
export class MinimalToolsMessageProcessor {
  /**
   * Unwraps a single callTool ToolCall into the real underlying ToolCall.
   * Returns null if this is not a callTool invocation.
   */
  private unwrapCallTool(toolCall: ToolCall): ToolCall | null {
    if (toolCall.function.name !== "callTool") {
      return null;
    }

    let parsed: { name?: string; args?: Record<string, any> };
    try {
      parsed =
        typeof toolCall.function.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;
    } catch {
      return null;
    }

    const { name, args } = parsed;
    if (!name || typeof name !== "string") {
      return null;
    }

    return {
      id: toolCall.id,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args ?? {}),
      },
    };
  }

  /**
   * Processes the modified messages array in-place:
   * - Finds assistant messages whose tool_calls contain callTool invocations.
   * - Replaces those callTool entries with the real underlying tool calls.
   *
   * Only the most-recent assistant message (the one just added by the AI) is
   * rewritten — older messages are left untouched so caching is not affected.
   */
  private processMessages(
    _originalMessages: Message[],
    modifiedMessages: Message[]
  ): void {
    // Walk backwards to find the last assistant message with tool_calls
    for (let i = modifiedMessages.length - 1; i >= 0; i--) {
      const msg = modifiedMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls?.length) {
        continue;
      }

      let didUnwrap = false;
      const newToolCalls: ToolCall[] = msg.tool_calls.map((tc) => {
        const unwrapped = this.unwrapCallTool(tc);
        if (unwrapped) {
          didUnwrap = true;
          return unwrapped;
        }
        return tc;
      });

      if (didUnwrap) {
        msg.tool_calls = newToolCalls;
      }

      // Only process the last assistant message
      break;
    }
  }

  /**
   * Returns a MessageProcessorFunction suitable for registering on the
   * `pre_tools` lifecycle of a MessageProcessor.
   */
  createProcessor(): MessageProcessorFunction {
    return (
      originalMessages: Message[],
      modifiedMessages: Message[]
    ): void => {
      this.processMessages(originalMessages, modifiedMessages);
    };
  }
}

export const globalMinimalToolsMessageProcessor =
  new MinimalToolsMessageProcessor();
