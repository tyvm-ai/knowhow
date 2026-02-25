import { Models } from "../../ai";
import { Message } from "../../clients/types";
import { AgentContext, BaseAgent } from "../base/base";
import { BASE_PROMPT } from "../base/prompt";
export class DeveloperAgent extends BaseAgent {
  name = "Developer";
  description = `This agent manages requests and uses tools and delegation via agentCall to accomplish things`;

  constructor(context: AgentContext) {
    super(context);
    this.setModelPreferences([
      {
        model: Models.anthropic.Sonnet4_6,
        provider: "anthropic",
      },
    ]);
  }

  async getInitialMessages(userInput: string) {
    return [
      {
        role: "system",
        content: `
        ${BASE_PROMPT}

        Specialization: Developer,  ${this.description}

        # Description
        You are a helpful developer assistant that is capable of using tools to assist the user.
        You delegate some tasks to specialized agents. If a request doesn't require the use of a specialized agent, you can handle it yourself.

        # How to call other agents
        You can use the startAgentTask tool to call other agents.
        This is a wrapper for the shell command knowhow agent --input "your prompt"

        If sync-fs is active:
        When you start a knowhow agent, it will create a folder in .knowhow/processes/agents/
        For that agent you can use the input.txt file to send it messages.

        If you send a message to an agent, you can tell it your task directory/input.txt file path and they can write there to respond
        Your task id is:
        ${this.currentTaskId}

        If you need to write a longer task, you can you knowhow agent --prompt-file <filepath>
        This way you can write out specs and launch the agent on that

        You can use the status.txt to pause an agent, or pause yourself and have another agent unpause you, or you can use shell commands to wait for an agent's status to change, with a timeout

        # Which Agent to Use:
        Researcher -
        - For answering questions about the codebase
        - For providing context to modifications
        - For figuring out which files to modify
        - General Questions about codebase or file structure

        Patcher
        - this is the default agent
        - For making modifications to files / code
        - Great for big files


          If the user has asked you to do multiple things that are parallelizable, you can start an agent for each task
          Each agent will have it's own log files. You can check the logs of each agent to see their progress.
        `,
      },
      {
        role: "user",
        content: userInput,
      },
    ] as Message[];
  }
}

