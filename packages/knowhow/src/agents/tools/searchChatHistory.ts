import { Tool } from "../../clients/types";
import { getConfig } from "../../config";
import { ChatHistoryEntry, ChatHistoryIndex, truncate } from "../../services/ChatHistoryIndex";

export interface SearchChatHistoryParams {
  /** What to look for (semantic search over past prompts + answers). */
  query?: string;
  /** Fetch one interaction by task id instead of searching. */
  taskId?: string;
  /** Max results. Default 10. */
  limit?: number;
  /** Max characters of each answer. Default 1500 (0 = full answer). */
  maxAnswerChars?: number;
}

function present(e: ChatHistoryEntry, maxAnswerChars: number, similarity?: number) {
  return {
    taskId: e.id,
    date: e.metadata.endTime ? new Date(e.metadata.endTime).toISOString() : undefined,
    ...(similarity !== undefined && { similarity: Number(similarity.toFixed(3)) }),
    prompt: e.input,
    finalAnswer: truncate(e.output, maxAnswerChars),
    sessionFile: e.metadata.sessionFile,
    agentName: e.metadata.agentName,
    model: e.metadata.model,
    ...(e.metadata.knowhowTaskId && { knowhowTaskId: e.metadata.knowhowTaskId }),
    ...(e.metadata.apiUrl && { apiUrl: e.metadata.apiUrl }),
  };
}

/**
 * Semantic search over this project's past terminal chat interactions
 * (prompt + final answer of each task), backed by the chat history index.
 */
export async function searchChatHistory(params: SearchChatHistoryParams = {}) {
  const { query, taskId, limit = 10, maxAnswerChars = 1500 } = params;
  const config = await getConfig().catch(() => undefined);
  const index = new ChatHistoryIndex({
    embeddingModel: config?.embeddingModel,
    includeAgentTasks: config?.chat?.history?.includeAgentTasks,
  });
  await index.sync();

  if (taskId) {
    const entry = index.get(taskId);
    return JSON.stringify(
      entry
        ? present(entry, maxAnswerChars)
        : { error: `No chat history entry for task ${taskId}` }
    );
  }
  if (!query) {
    // No query: the most recent interactions.
    return JSON.stringify(
      index.recent(Math.max(1, limit)).map((e) => present(e, maxAnswerChars))
    );
  }
  const results = await index.search(query, { limit: Math.max(1, limit) });
  return JSON.stringify(results.map((e) => present(e, maxAnswerChars, e.similarity)));
}

export const searchChatHistoryDefinition: Tool = {
  type: "function",
  function: {
    name: "searchChatHistory",
    description:
      "Search this project's past terminal chat interactions (what the user asked and the final answer of each task) " +
      "by meaning, e.g. to recall earlier decisions, findings or work. Returns the most similar interactions with " +
      "taskId, date, prompt, finalAnswer and the sessionFile holding the full transcript (readable with readFile). " +
      "Pass taskId to fetch one interaction, or omit query for the most recent ones.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        query: {
          type: "string",
          description: "What to look for, in natural language.",
        },
        taskId: {
          type: "string",
          description: "Fetch a single interaction by its task id.",
        },
        limit: {
          type: "number",
          description: "Max results (default 10).",
        },
        maxAnswerChars: {
          type: "number",
          description: "Max characters of each final answer (default 1500, 0 for the full answer).",
        },
      },
      required: [],
    },
  },
};
