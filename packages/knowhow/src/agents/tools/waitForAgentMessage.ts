import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";

export interface WaitForAgentMessageParams {
  /**
   * Only wake for a message from this agent (matches the `[from:<taskId>...]` envelope that
   * sendAgentMessage / replyToParent attach; a taskId prefix is enough). Other messages still
   * arrive normally on your next turn, they just don't end this wait.
   */
  fromTaskId?: string;
  /** Max time to wait. Default 10 minutes. Always set this so you can re-check instead of waiting forever. */
  timeoutMs?: number;
  /** Poll interval. Default 500ms. */
  pollIntervalMs?: number;
  _ctx?: ToolCallContext;
}

function messageToText(m: any): string {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function matches(texts: string[], fromTaskId?: string) {
  if (!fromTaskId) return texts.length > 0;
  return texts.some((t) => t.includes(`[from:${fromTaskId}`));
}

/**
 * Block until the calling agent has an incoming message (optionally from a specific agent), a
 * timeout elapses, or the user interrupts. The message is only PEEKED at, never consumed: it is
 * delivered to you as a normal user message on your next turn (right after this tool returns).
 *
 * This is the "tell me when it's green" primitive for sibling agents: ask a peer via
 * sendAgentMessage, then waitForAgentMessage({ fromTaskId, timeoutMs }). If it times out, check
 * on the peer with listAgents / `knowhow agents status` and ask again or carry on.
 */
export async function waitForAgentMessage(params: WaitForAgentMessageParams = {}) {
  const { fromTaskId, timeoutMs = 10 * 60 * 1000, pollIntervalMs = 500, _ctx } = params;
  const caller = _ctx?.caller;
  const signal: AbortSignal | undefined = _ctx?.signal;
  const start = Date.now();

  if (!caller || typeof caller.peekPendingMessages !== "function") {
    return JSON.stringify({
      status: "error",
      reason: "unsupported",
      error: "waitForAgentMessage needs to run inside an agent loop (no caller context).",
    });
  }

  while (true) {
    const texts: string[] = caller.peekPendingMessages().map(messageToText);
    if (matches(texts, fromTaskId)) {
      return JSON.stringify({
        status: "message",
        reason: "message",
        elapsedMs: Date.now() - start,
        hint: "The message is delivered to you as your next user message.",
        preview: texts
          .filter((t) => !fromTaskId || t.includes(`[from:${fromTaskId}`))
          .map((t) => t.slice(0, 300))[0],
      });
    }
    if (signal?.aborted) {
      return JSON.stringify({
        status: "interrupted",
        reason: "user_interrupt",
        elapsedMs: Date.now() - start,
      });
    }
    if (Date.now() - start >= timeoutMs) {
      return JSON.stringify({
        status: "timeout",
        reason: "timeout",
        timedOut: true,
        elapsedMs: Date.now() - start,
        hint: fromTaskId
          ? `No message from ${fromTaskId} yet. Check it with listAgents, re-send your request with sendAgentMessage, or continue without it.`
          : "No message arrived.",
      });
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, Math.max(100, pollIntervalMs));
      function done() {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export const waitForAgentMessageDefinition: Tool = {
  type: "function",
  function: {
    name: "waitForAgentMessage",
    description:
      "Block until you receive a message from another agent (sendAgentMessage / replyToParent), the user, " +
      "or a timeout. Use it for peer/sibling collaboration: e.g. 'I need the build green; I see agent X is " +
      "editing it' -> sendAgentMessage(X, 'ping me when the build passes') then " +
      "waitForAgentMessage({ fromTaskId: X, timeoutMs: 600000 }). On timeout, re-check X with listAgents and " +
      "re-ask (don't wait forever). The message is not consumed; it arrives as your next user message. " +
      "(To wait for an agent to FINISH use waitForAgentCompleted; for CI/polling workflows use startScript/executeScript.)",
    parameters: {
      type: "object",
      positional: false,
      usesContext: true,
      properties: {
        fromTaskId: {
          type: "string",
          description:
            "Only end the wait for a message from this agent taskId (prefix ok). Omit to wake on any message.",
        },
        timeoutMs: {
          type: "number",
          description: "Max wait in ms (default 600000 = 10 min). Always set a sensible timeout.",
        },
        pollIntervalMs: {
          type: "number",
          description: "Poll interval in ms (default 500).",
        },
      },
      required: [],
    },
  },
};
