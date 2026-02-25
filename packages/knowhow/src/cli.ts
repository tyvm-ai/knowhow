#!/usr/bin/env node --no-node-snapshot
import "source-map-support/register";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Command } from "commander";
import { execSync } from "child_process";
import { version } from "../package.json";
import { generate, embed, upload } from "./index";
import { init } from "./config";

import { download, purge } from ".";
import { includedTools } from "./agents/tools/list";
import * as allTools from "./agents/tools";
import { LazyToolsService, services } from "./services";
import { login } from "./login";
import { worker } from "./worker";
import {
  startAllWorkers,
  listWorkerPaths,
  unregisterWorkerPath,
  clearWorkerRegistry,
} from "./workerRegistry";
import { agents } from "./agents";
import { startChat } from "./chat";
import { askAI } from "./chat-old";
import { getConfiguredEmbeddingMap, queryEmbedding } from "./embeddings";
import { getConfig } from "./config";
import { getEnabledPlugins } from "./types";
import { marked } from "marked";
import { BaseAgent } from "./agents/base/base";
import { AskModule } from "./chat/modules/AskModule";
import { SearchModule } from "./chat/modules/SearchModule";
import { AgentModule } from "./chat/modules/AgentModule";
import { readPromptFile } from "./ai";
import { SetupModule } from "./chat/modules/SetupModule";
import { CliChatService } from "./chat/CliChatService";

async function setupServices() {
  const { Agents, Mcp, Clients, Tools: OldTools } = services();
  const Tools = new LazyToolsService();

  // We need to wireup the LazyTools to be connected to the same singletons that are in services()
  Tools.setContext({
    ...OldTools.getContext(),
  });

  const { Researcher, Developer, Patcher, Setup } = agents({
    ...services(),
    Tools,
  });

  Agents.registerAgent(Researcher);
  Agents.registerAgent(Patcher);
  Agents.registerAgent(Developer);
  Agents.registerAgent(Setup);
  Agents.loadAgentsFromConfig(services());

  Tools.defineTools(includedTools, allTools);

  // Add Mcp service to tool context directly so MCP management tools can access it
  Tools.addContext("Mcp", Mcp);

  console.log("🔌 Connecting to MCP...");
  await Mcp.connectToConfigured(Tools);
  console.log("Connecting to clients...");
  await Clients.registerConfiguredModels();
  console.log("✓ Services are set up and ready to go!");
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
  const chatService = new CliChatService(getEnabledPlugins(config.plugins));

  program
    .name("knowhow")
    .description("AI CLI with plugins and agents")
    .version(version);

  program
    .command("init")
    .description("Initialize knowhow configuration")
    .action(async () => {
      await init();
    });

  program
    .command("login")
    .description("Login to knowhow")
    .option("--jwt", "Use manual JWT input instead of browser login")
    .action(async (opts) => {
      await login(opts.jwt);
    });

  program
    .command("update")
    .description("Update knowhow to the latest version from npm")
    .action(async () => {
      try {
        console.log("🔄 Checking for knowhow updates...");
        console.log(`Current version: ${version}`);

        console.log("📦 Installing latest version from npm...");
        execSync("npm install -g knowhow@latest", {
          stdio: "inherit",
          encoding: "utf-8",
        });

        console.log("✓ knowhow has been updated successfully!");
        console.log("Run 'knowhow --version' to see the new version.");
      } catch (error) {
        console.error("Error updating knowhow:", error.message);
        process.exit(1);
      }
    });

  program
    .command("generate")
    .description("Generate documentation")
    .action(async () => {
      await setupServices();
      await generate();
    });

  program
    .command("embed")
    .description("Create embeddings")
    .action(async () => {
      await setupServices();
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
    .description("Start new chat interface")
    .action(async () => {
      await setupServices();
      await startChat();
    });

  program
    .command("agent")
    .description("Spin up agents directly from CLI")
    .option(
      "--provider <provider>",
      "AI provider (openai, anthropic, google, xai)"
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
    .option("--sync-fs", "Enable filesystem-based synchronization")
    .option("--task-id <taskId>", "Pre-generated task ID (used with --sync-fs for predictable agent directory path)")
    .option("--prompt-file <path>", "Custom prompt template file with {text}")
    .option("--input <text>", "Task input (fallback to stdin if not provided)")
    .action(async (options) => {
      try {
        await setupServices();
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

        const agentModule = new AgentModule();
        await agentModule.initialize(chatService);
        const { taskCompleted } = await agentModule.setupAgent({
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
    .option("--provider <provider>", "AI provider to use")
    .option("--model <model>", "Specific model")
    .option("--input <text>", "Question (fallback to stdin if not provided)")
    .option("--prompt-file <path>", "Custom prompt template file")
    .action(async (options) => {
      try {
        await setupServices();
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

        const askModule = new AskModule();
        await askModule.initialize(chatService);
        await askModule.processAIQuery(input, {
          plugins: config.plugins.enabled,
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
        await setupServices();
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
        await setupServices();
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
        const agentModule = new AgentModule();
        await agentModule.initialize(chatService);
        await agentModule.logSessionTable();
      } catch (error) {
        console.error("Error listing sessions:", error);
        process.exit(1);
      }
    });

  program
    .command("worker")
    .description(
      "Start worker process and optionally register current directory"
    )
    .option("--register", "Register current directory as a worker path")
    .option(
      "--share",
      "Share this worker with your organization (allows other users to use it)"
    )
    .option("--unshare", "Make this worker private (only you can use it)")
    .option("--sandbox", "Run worker in a Docker container for isolation")
    .option(
      "--no-sandbox",
      "Run worker directly on host (disable sandbox mode)"
    )
    .action(async (options) => {
      await setupServices();
      await worker(options);
    });

  program
    .command("workers")
    .description("Manage and start all registered workers")
    .option("--list", "List all registered worker paths")
    .option("--unregister <path>", "Unregister a worker path")
    .option("--clear", "Clear all registered worker paths")
    .action(async (options) => {
      try {
        if (options.list) {
          const workers = await listWorkerPaths();
          if (workers.length === 0) {
            console.log("No workers registered.");
            console.log(
              "\nTo register a worker, run 'knowhow worker --register' from the worker directory."
            );
          } else {
            console.log(`Registered workers (${workers.length}):`);
            workers.forEach((workerPath, index) => {
              console.log(`  ${index + 1}. ${workerPath}`);
            });
          }
          return;
        }

        if (options.unregister) {
          await unregisterWorkerPath(options.unregister);
          return;
        }

        if (options.clear) {
          await clearWorkerRegistry();
          return;
        }

        // Default action: start all workers
        await setupServices();
        await startAllWorkers();
      } catch (error) {
        console.error("Error managing workers:", error);
        process.exit(1);
      }
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
