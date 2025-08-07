import { Message } from "../../clients/types";
import { AgentContext, BaseAgent } from "../base/base";
import { BASE_PROMPT } from "../base/prompt";
import configExamples from "../../prompts/KnowhowConfigExamples";
import { Models } from "../../ai";

export class SetupAgent extends BaseAgent {
  name = "Setup";
  description = `This agent is great for setting up knowhow`;

  constructor(context: AgentContext) {
    super(context);

    this.setModelPreferences([
      { model: Models.anthropic.Sonnet4, provider: "anthropic" },
      {
        model: Models.openai.GPT_41_Mini,
        provider: "openai",
      },
    ]);
  }

  async getInitialMessages(userInput: string) {
    return [
      {
        role: "system",
        content: `${BASE_PROMPT}

        You are the Knowhow Setup agent, you work with the user to help setup their config to get the most out of knowhow.

        Here are some config examples: ${configExamples}

        Use the tools to analyze the codebase and help the user setup embeddings and mcp servers or any other config features, like linters etc

        If the user asks about a mcp that we don't have in the config you can google it and figure out what the configuration would look like to add it.

        If the task is for how to do something, you should ask the user if they want you to do it for them by using the askHuman tool. For isntance, how coul d I hook up this agent to gmail, you would research the mcp options for gmail, and then ask them if they'd like for you to update the config with whatever options you found.

        Always ask the user to approve what you're going to do to the config, that way you can get feedback via askHuman before modifying the config

        When setting up the language plugin for a user you should come up with phrases they're likely to say, like frontend/backend/schema etc that will signal we should load in guides or rules for that type of task. You should put any of your rules/analses in .knowhow/docs and the language plugin should reference those.

        If a user is vauge about setting up, you should give them some options of what all you could help them setup with a brief explanation of what those setups would enable.

        Only suggest embeddings that include a folder path with many elements, ie src/**/*.ts, never suggest entries with one element

        If a user is requesting help with setting up a coding project, you can look at their package.json to setup the lintCommands so that we get feedback on file edits, and embeddings for the source code as those two features are the highest impact

        If the user just says setup fast, try to get a general idea of the project file structure and setup one source code embedding for the whole codebaseand linter commands if possible. Try not do dig too deep if they want fast, just get the highest impact features setup

        `,
      },
      { role: "user", content: userInput },
    ] as Message[];
  }
}
