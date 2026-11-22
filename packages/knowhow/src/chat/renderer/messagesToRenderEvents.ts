/**
 * Utility: Convert OpenAI-format Message[] threads into RenderEvent[] for the renderer.
 * Shared by SyncedAgentWatcher implementations and the /logs command.
 */

import { RenderEvent } from "../../chat/renderer/types";

export interface Message {
  role: "assistant" | "user" | "tool" | "system";
  content?: any;
  tool_calls?: Array<{
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
  tool_call_id?: string;
  reasoning_summary?: string;
}

/**
 * Text of a message's content: strings as-is, content-part arrays
 * ([{type:"text",text}, …]) joined by newlines, anything else stringified.
 * Mirrors the frontend's getMessageText/extractText.
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const part = c as { type?: unknown; text?: unknown };
          if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") {
            return part.text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  if (typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : JSON.stringify(content);
  }
  return String(content);
}

export function messagesToRenderEvents(
  messages: Message[],
  taskId: string,
  agentName: string
): RenderEvent[] {
  const events: RenderEvent[] = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "assistant") {
      if (msg.reasoning_summary && typeof msg.reasoning_summary === "string") {
        events.push({
          type: "agentMessage",
          taskId,
          agentName,
          message: `💭 ${msg.reasoning_summary}`,
          role: "assistant",
        });
      }
      const text = contentToText(msg.content);
      if (text.trim()) {
        events.push({
          type: "agentMessage",
          taskId,
          agentName,
          message: text,
          role: "assistant",
        });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          events.push({
            type: "toolCall",
            taskId,
            agentName,
            toolCall: {
              id: tc.id,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          });
        }
      }
    } else if (msg.role === "tool") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      events.push({
        type: "toolResult",
        taskId,
        agentName,
        toolCall: { function: { name: msg.name || "unknown", arguments: "" } },
        result: content,
      });
    } else if (msg.role === "user") {
      const content = contentToText(msg.content);
      // Skip workflow messages — these are internal agent control messages
      // injected as user-role messages and should not be rendered to the user
      if (content.trim().startsWith("<Workflow>") || /<Workflow>/i.test(content)) {
        continue;
      }
      if (content) {
        events.push({
          type: "agentMessage",
          taskId,
          agentName,
          message: content,
          role: "user",
        });
      }
    }
  }

  return events;
}
