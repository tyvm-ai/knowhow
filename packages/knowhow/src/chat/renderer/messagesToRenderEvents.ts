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
}

export function messagesToRenderEvents(
  messages: Message[],
  taskId: string,
  agentName: string
): RenderEvent[] {
  const events: RenderEvent[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content) {
        events.push({
          type: "agentMessage",
          taskId,
          agentName,
          message: msg.content,
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
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
          ? msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
          : String(msg.content ?? "");
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
