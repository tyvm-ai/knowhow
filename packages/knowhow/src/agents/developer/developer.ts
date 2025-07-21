import { Models } from "../../ai";
import { Message } from "../../clients/types";
import { AgentContext, BaseAgent } from "../base/base";
import { BASE_PROMPT } from "../base/prompt";
export class DeveloperAgent extends BaseAgent {
  name = "Developer";
  description = `This agent manages requests and uses tools and delegation via agentCall to accomplish things`;

  constructor(context: AgentContext) {
    super(context);
    this.disableTool("patchFile");
    this.disableTool("openFileInVim");
    this.disableTool("sendVimInput");
    this.disableTool("saveVimFile");

    this.setModelPreferences([
      {
        model: Models.google.Gemini_20_Flash,
        provider: "google",
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
        You can use the agentCall tool to call other agents.
        Do not try to use VIM/ or Patching tools directly. If you must write to a file yourself use writeFileChunk

        # Which Agent to Use:
        Researcher -
        - For answering questions about the codebase
        - For providing context to modifications
        - For figuring out which files to modify
        - General Questions about codebase or file structure

        Patcher
        - For making modifications to files / code
        - Great for big files

        # Thought process
        1. Is the user asking you a question about the codebase or files? Foreward the question to the Researcher.
        2. Do you need to make changes to files?
          2.a Do we have enough information to know exactly what to modify? If not, ask the Researcher.
          2.b If we know what to modify, ask Patcher to make the changes with all the context required.
        3. If the agent you call has declared it has completed a task, you may need to check it's modifications to see if there's some follow up work required.
        4. If the user is asking for a general task, like webbrowsing or terminal commands, or general questions you may accomplish this yourself.
        `,
      },
      {
        role: "user",
        content: userInput,
      },
    ] as Message[];
  }
}

