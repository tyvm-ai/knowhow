#!/usr/bin/env node
import "source-map-support/register";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Command } from "commander";
import { generate, embed, upload, chat } from "./index";
import { init } from "./config";

import { download, purge } from ".";
import { includedTools } from "./agents/tools/list";
import * as allTools from "./agents/tools";
import { services } from "./services";
import { login } from "./login";
import { worker } from "./worker";
import { agents } from "./agents";
import { startChat2 } from "./chat2";
import { askAI } from "./chat";
import { getConfiguredEmbeddingMap, queryEmbedding } from "./embeddings";
import { getConfig } from "./config";
import { marked } from "marked";
import { BaseAgent } from "./agents/base/base";
import { AskModule } from "./chat/modules/AskModule";
import { SearchModule } from "./chat/modules/SearchModule";
import { AgentModule } from "./chat/modules/AgentModule";
import { readPromptFile } from "./ai";
import { SetupModule } from "./chat/modules/SetupModule";
import { CliChatService } from "./chat/CliChatService";

async function setupServices() {
  const { Tools, Agents, Mcp, Clients } = services();
  const { Researcher, Developer, Patcher, Setup } = agents();
  Agents.registerAgent(Researcher);
  Agents.registerAgent(Patcher);
  Agents.registerAgent(Developer);
  Agents.registerAgent(Setup);
  Agents.loadAgentsFromConfig(services());

  Tools.defineTools(includedTools, allTools);

  await Promise.all([
    Mcp.connectToConfigured(Tools),
    Clients.registerConfiguredModels(),
  ]);
}

// Utility function to read from stdin
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");

    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    process.stdin.on("readable", () => {
      const chunk = process.stdin.read();
      if (chunk !== null) data += chunk;
    });

    process.stdin.on("end", () => resolve(data.trim()));
  });
}

async function main() {
  const program = new Command();
  const config = await getConfig();

  program
    .name("knowhow")
    .description("AI CLI with plugins and agents")
    .version("0.0.33");

  // Initialize services for all commands
  await setupServices();

  program
    .command("init")
    .description("Initialize knowhow configuration")
    .action(async () => {
      await init();
    });

  program
    .command("login")
    .description("Login to knowhow")
    .option("--jwt", "should use JWT login", "true")
    .action(async (opts) => {
      await login(opts.jwt);
    });

  program
    .command("generate")
    .description("Generate documentation")
    .action(async () => {
      await generate();
    });

  program
    .command("embed")
    .description("Create embeddings")
    .action(async () => {
      await embed();
    });

  program
    .command("embed:purge")
    .description("Purge embeddings matching a glob pattern")
    .argument("<pattern>", "Glob pattern to match files for purging")
    .action(async (pattern) => {
      await purge(pattern);
    });

  program
    .command("upload")
    .description("Upload data")
    .action(async () => {
      await upload();
    });

  program
    .command("download")
    .description("Download data")
    .action(async () => {
      await download();
    });

  program
    .command("chat")
    .description("Start chat interface")
    .action(async () => {
      await chat();
    });

  program
    .command("chat2")
    .description("Start new chat interface")
    .action(async () => {
      await startChat2();
    });

  program
    .command("agent")
    .description("Spin up agents directly from CLI")
    .option(
      "--provider <provider>",
      "AI provider (openai, anthropic, google, xai)",
      "openai"
    )
    .option("--model <model>", "Specific model for the provider")
    .option("--agent-name <name>", "Which agent to use", "Patcher")
    .option(
      "--max-time-limit <minutes>",
      "Time limit for agent execution (minutes)",
      "30"
    )
    .option(
      "--max-spend-limit <dollars>",
      "Cost limit for agent execution (dollars)",
      "10"
    )
    .option("--message-id <messageId>", "Knowhow message ID for task tracking")
    .option("--prompt-file <path>", "Custom prompt template file with {text}")
    .option("--input <text>", "Task input (fallback to stdin if not provided)")
    .action(async (options) => {
      try {
        let input = options.input;
        if (!input) {
          input = await readStdin();
          if (!input) {
            console.error(
              "Error: No input provided. Use --input flag or pipe input via stdin."
            );
            process.exit(1);
          }
        }

        input = readPromptFile(options.promptFile, input);
        const { taskCompleted } = await new AgentModule().setupAgent({
          ...options,
          input,
          maxTimeLimit: parseInt(options.maxTimeLimit, 10),
          maxSpendLimit: parseFloat(options.maxSpendLimit),
          run: true,
        });
        await taskCompleted;
      } catch (error) {
        console.error("Error running agent:", error);
        process.exit(1);
      }
    });

  program
    .command("ask")
    .description("Direct AI questioning without agent overhead")
    .option("--provider <provider>", "AI provider to use", "openai")
    .option("--model <model>", "Specific model")
    .option("--input <text>", "Question (fallback to stdin if not provided)")
    .option("--prompt-file <path>", "Custom prompt template file")
    .action(async (options) => {
      try {
        let input = options.input;
        if (!input) {
          input = await readStdin();
          if (!input) {
            console.error(
              "Error: No question provided. Use --input flag or pipe input via stdin."
            );
            process.exit(1);
          }
        }

        input = readPromptFile(options.promptFile, input);

        await new AskModule().processAIQuery(input, {
          plugins: config.plugins,
          currentModel: options.model,
          currentProvider: options.provider,
        });
      } catch (error) {
        console.error("Error asking AI:", error);
        process.exit(1);
      }
    });

  program
    .command("setup")
    .description("Ask the agent to configure knowhow")
    .action(async (options) => {
      try {
        const chatService = new CliChatService(config.plugins);
        const setupModule = new SetupModule();
        await setupModule.initialize(chatService);
        await setupModule.handleSetupCommand([]);
      } catch (error) {
        console.error("Error running agent:", error);
        process.exit(1);
      }
    });

  program
    .command("search")
    .description("Search embeddings directly from CLI")
    .option(
      "--input <text>",
      "Search query (fallback to stdin if not provided)"
    )
    .option(
      "-e, --embedding <path>",
      "Specific embedding path (default: all)",
      "all"
    )
    .action(async (options) => {
      try {
        let input = options.input;
        if (!input) {
          input = await readStdin();
          if (!input) {
            console.error(
              "Error: No search query provided. Use --input flag or pipe input via stdin."
            );
            process.exit(1);
          }
        }

        await new SearchModule().searchEmbeddingsCLI(input, options.embedding);
      } catch (error) {
        console.error("Error searching embeddings:", error);
        process.exit(1);
      }
    });

  program
    .command("sessions")
    .description("Manage agent sessions from CLI")
    .action(async () => {
      try {
        await new AgentModule().logSessionTable();
      } catch (error) {
        console.error("Error listing sessions:", error);
        process.exit(1);
      }
    });

  program
    .command("worker")
    .description("Start worker process")
    .action(async () => {
      await worker();
    });

  await program.parseAsync(process.argv);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit(0);
    });
}
