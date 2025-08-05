import { Tool } from "../../clients/types";
import { KnowhowSimpleClient } from "../../services/KnowhowClient";
import { CreateMessageTaskRequest, CreateMessageTaskResponse } from "../../types";

interface StartChatTaskParams {
  messageId: string;
  prompt: string;
}

/**
 * Creates a chat task in Knowhow based on a message ID and prompt.
 * This allows external agents to start tasks that can receive real-time updates.
 */
export async function startChatTask(params: StartChatTaskParams): Promise<CreateMessageTaskResponse> {
  const { messageId, prompt } = params;

  if (!messageId) {
    throw new Error("messageId is required to create a chat task");
  }

  if (!prompt) {
    throw new Error("prompt is required to create a chat task");
  }

  const baseUrl = process.env.KNOWHOW_BASE_URL || "https://app.knowhow.dev";
  const client = new KnowhowSimpleClient(baseUrl);
  
  const request: CreateMessageTaskRequest = {
    messageId,
    prompt,
  };

  try {
    const response = await client.createChatTask(request);
    return response.data;
  } catch (error) {
    console.error("Error creating chat task:", error);
    throw error;
  }
}

export const startChatTaskDefinition: Tool = {
  type: "function",
  function: {
    name: "startChatTask",
    description: "Create a new chat task in Knowhow based on a message ID and prompt. This allows external agents to start tasks that can receive real-time updates via WebSocket broadcasting.",
    parameters: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The ID of the message in Knowhow to associate with this task",
        },
        prompt: {
          type: "string",
          description: "The prompt or description for the task to be created",
        },
      },
      required: ["messageId", "prompt"],
    },
  },
};

export default startChatTask;