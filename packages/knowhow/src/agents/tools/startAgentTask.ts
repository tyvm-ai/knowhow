import { Tool } from "../../clients/types";
import { execCommand } from "./execCommand";

interface StartAgentTaskParams {
  messageId: string;
  prompt: string;
  provider?: string;
  model?: string;
  agentName?: string;
  maxTimeLimit?: number;
  maxSpendLimit?: number;
}

/**
 * Creates a chat task in Knowhow based on a message ID and prompt.
 * This allows external agents to start tasks that can receive real-time updates.
 */
export async function startAgentTask(params: StartAgentTaskParams) {
  const {
    messageId,
    prompt,
    provider,
    model,
    agentName,
    maxTimeLimit,
    maxSpendLimit,
  } = params;

  if (!messageId) {
    throw new Error("messageId is required to create a chat task");
  }

  if (!prompt) {
    throw new Error("prompt is required to create a chat task");
  }

  const escapedPrompt = prompt.replace(/"/g, '\\"');

  // Build the command with all optional parameters
  let command = `knowhow agent --input "${escapedPrompt}" --message-id ${messageId}`;

  if (provider) {
    command += ` --provider ${provider}`;
  }

  if (model) {
    command += ` --model "${model}"`;
  }

  if (agentName) {
    command += ` --agent-name "${agentName}"`;
  }

  if (maxTimeLimit !== undefined) {
    command += ` --max-time-limit ${maxTimeLimit}`;
  }

  if (maxSpendLimit !== undefined) {
    command += ` --max-spend-limit ${maxSpendLimit}`;
  }

  return execCommand(command, 60000, true);
}

export const startAgentTaskDefinition: Tool = {
  type: "function",
  function: {
    name: "startAgentTask",
    description:
      "Create a new chat task in Knowhow based on a message ID and prompt. This allows worker agents to start tasks and update knowhow's backend with all CLI agent options",
    parameters: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description:
            "The ID of the message in Knowhow to associate with this task",
        },
        prompt: {
          type: "string",
          description: "The prompt or description for the task to be created",
        },
        provider: {
          type: "string",
          description:
            "AI provider (openai, anthropic, google, xai). Default: openai",
        },
        model: {
          type: "string",
          description: "Specific model for the provider",
        },
        agentName: {
          type: "string",
          description: "Which agent to use. Default: Patcher",
        },
        maxTimeLimit: {
          type: "number",
          description: "Time limit for agent execution in minutes. Default: 30",
        },
        maxSpendLimit: {
          type: "number",
          description: "Cost limit for agent execution in dollars. Default: 10",
        },
      },
      required: ["messageId", "prompt"],
    },
  },
};

