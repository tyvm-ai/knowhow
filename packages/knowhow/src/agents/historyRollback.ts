import { Message } from "../clients/types";

/**
 * Remove the newest agent interactions from the final persisted thread.
 *
 * An interaction starts with an assistant message and includes every following
 * tool result up to (but not including) the next assistant message. Cutting at
 * the assistant boundary keeps tool_call/tool-result pairs valid and makes
 * `rollback: 1` useful for recovering from a failed final tool-use turn.
 */
export function rollbackAgentInteractions(
  threads: Message[][],
  rollback: number = 0
): Message[][] {
  if (!Number.isInteger(rollback) || rollback < 0) {
    throw new Error("rollback must be a non-negative integer");
  }

  const cloned = threads.map((thread) => thread.map((message) => ({ ...message })));
  if (rollback === 0 || cloned.length === 0) return cloned;

  const lastThread = cloned[cloned.length - 1];
  const assistantIndexes = lastThread
    .map((message, index) => (message.role === "assistant" ? index : -1))
    .filter((index) => index >= 0);

  if (rollback > assistantIndexes.length) {
    throw new Error(
      `Cannot rollback ${rollback} interaction(s); the latest thread only has ${assistantIndexes.length} assistant interaction(s).`
    );
  }

  const cutIndex = assistantIndexes[assistantIndexes.length - rollback];
  cloned[cloned.length - 1] = lastThread.slice(0, cutIndex);
  return cloned;
}
