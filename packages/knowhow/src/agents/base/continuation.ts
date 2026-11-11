import { Message } from "../../clients/types";

/**
 * Decide whether the agent loop must inject the "you did not call a required
 * tool" nudge before the next turn.
 *
 * Only nag when the model ended its turn with a plain assistant message (no
 * tool calls). After tool results (last role === "tool") the model simply
 * continues; nagging there fired after EVERY tool step and wasted tokens.
 */
export function shouldNagForRequiredTool(
  messages: Pick<Message, "role" | "tool_calls">[]
): boolean {
  const last = messages[messages.length - 1];
  if (!last) {
    return false;
  }
  if (last.role !== "assistant") {
    return false;
  }
  return !(last.tool_calls && last.tool_calls.length > 0);
}

export function buildRequiredToolNag(
  requiredToolNames: string[],
  statusMessage: string
) {
  return `<Workflow>
        This is an automated runtime instruction, not a new user message.
        The original user request remains active. Do not say that the user's
        message was empty, and do not ask the user to repeat the request.

        Your previous response did not terminate the task because it did not
        call one of the required tools: ${JSON.stringify(requiredToolNames)}.
        If your previous response was intended as the final response, call the
        appropriate required tool now with that response. Otherwise, continue
        working on the original request and call an appropriate required tool
        when the task is complete.

        <TaskStatus>${statusMessage}</TaskStatus>
        </Workflow>`;
}
