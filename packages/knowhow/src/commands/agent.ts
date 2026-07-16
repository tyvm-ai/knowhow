import { Command } from "commander";
import { readPromptFile } from "../ai";
import { BehaviorsService } from "../services/BehaviorsService";
import { AgentModule } from "../chat/modules/AgentModule";
import { AskModule } from "../chat/modules/AskModule";
import { SearchModule } from "../chat/modules/SearchModule";
import { SessionsModule } from "../chat/modules/SessionsModule";
import { SetupModule } from "../chat/modules/SetupModule";
import { PlainRenderer } from "../chat/renderer/PlainRenderer";
import { loadRenderer } from "../chat/renderer/loadRenderer";
import { getConfig } from "../config";

async function setupRenderer(chatService: any, rendererSpecifier: string): Promise<void> {
  const resolved =
    rendererSpecifier === "basic" && !process.stdout.isTTY ? "plain" : rendererSpecifier;
  try {
    const renderer = await loadRenderer(resolved);
    chatService.setContext({ renderer });
  } catch (err: any) {
    console.warn(`⚠ Could not load renderer "${resolved}": ${err.message}`);
    console.warn("  Falling back to basic renderer.");
    try {
      const fallback = !process.stdout.isTTY ? new PlainRenderer() : await loadRenderer("basic");
      chatService.setContext({ renderer: fallback });
    } catch (_) {}
  }
}

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

export function addAgentCommand(program: Command, getChatService: () => any): void {
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
    .option(
      "--behavior-id <id>",
      "Force a specific behavior by its ID (skips trigger matching)"
    )
    .option(
      "--behavior-file <path>",
      "Force a specific behavior by its file path (skips trigger matching)"
    )
    .option(
      "--task-id <taskId>",
      "Pre-generated task ID (used with --sync-fs for predictable agent directory path)"
    )
    .option("--prompt-file <path>", "Custom prompt template file with {text}")
    .option("--input <text>", "Task input (fallback to stdin if not provided)")
    .option(
      "--resume",
      "Resume a previously started task using the --task-id (local FS or remote)"
    )
    .option(
      "--renderer <name>",
      "Renderer to use: basic, compact, fancy, or a path/package (default: from config or basic)"
    )
    .action(async (options) => {
      try {
        const { setupServices } = await import("./services");
        await setupServices();
        const chatService = getChatService();

        // Set up renderer: CLI flag > config.chat.renderer > "basic"
        let config: any = {};
        try { config = await getConfig(); } catch (_) {}
        const rendererSpecifier = options.renderer ?? config.chat?.renderer ?? "basic";
        await setupRenderer(chatService, rendererSpecifier);

        const agentModule = new AgentModule();

        if (options.resume) {
          const threads = await agentModule.loadThreadsForTask(
            options.taskId,
            options.messageId
          );
          const resumeInput =
            options.input || "Please continue from where you left off.";

          await agentModule.initialize(chatService);
          const { taskCompleted: resumed } =
            await agentModule.resumeFromMessages({
              agentName: options.agentName || "Patcher",
              input: resumeInput,
              threads,
              messageId: options.messageId,
              taskId: options.taskId,
            });
          await resumed;
          return;
        }

        let input = options.input;

        if (!input && !options.promptFile) {
          input = await readStdin();
        }

        input = readPromptFile(options.promptFile, input);

        if (!input) {
          console.error(
            "Error: No input provided. Use --input flag, pipe input via stdin, or provide --prompt-file."
          );
          process.exit(1);
        }

        await agentModule.initialize(chatService);

        // Match a behavior from local disk (.knowhow/behaviors/)
        let behaviorSystemPrompt: string | undefined;
        let behaviorModel: string | undefined;
        const behaviorsSvc = new BehaviorsService();

        let matchedBehavior = null;

        if (options.behaviorFile) {
          // Load behavior directly from a file path
          matchedBehavior = behaviorsSvc.loadBehaviorFromFile(options.behaviorFile);
          if (matchedBehavior) {
            console.log(`🎯 Using behavior from file: ${options.behaviorFile}`);
          } else {
            console.error(`❌ Could not load behavior from file: ${options.behaviorFile}`);
            process.exit(1);
          }
        } else if (options.behaviorId) {
          // Load behavior by ID (searches local disk behaviors)
          matchedBehavior = behaviorsSvc.findBehaviorById(options.behaviorId);
          if (matchedBehavior) {
            console.log(`🎯 Using behavior by ID: ${options.behaviorId} (${matchedBehavior.name})`);
          } else {
            console.error(`❌ No behavior found with ID: ${options.behaviorId}`);
            process.exit(1);
          }
        } else {
          // Default: match by trigger text
          matchedBehavior = behaviorsSvc.matchBehaviorLocal(input);
        }

        if (matchedBehavior) {
          console.log(`🎯 Matched behavior: ${matchedBehavior.name}`);
          if (matchedBehavior.instructions) {
            behaviorSystemPrompt = matchedBehavior.instructions;
          }
          if (matchedBehavior.model) {
            behaviorModel = matchedBehavior.model;
          }
        }

        const { taskCompleted } = await agentModule.setupAgent({
          ...options,
          input,
          maxTimeLimit: parseInt(options.maxTimeLimit, 10),
          maxSpendLimit: parseFloat(options.maxSpendLimit),
          ...(behaviorSystemPrompt ? { systemPrompt: behaviorSystemPrompt } : {}),
          ...(behaviorModel ? { model: behaviorModel } : {}),
          run: true,
        });
        await taskCompleted;
      } catch (error) {
        console.error("Error running agent:", error);
        process.exit(1);
      }
    });
}

export function addAskCommand(program: Command, getChatService: () => any, getConfig: () => any): void {
  program
    .command("ask")
    .description("Direct AI questioning without agent overhead")
    .option("--provider <provider>", "AI provider to use")
    .option("--model <model>", "Specific model")
    .option("--input <text>", "Question (fallback to stdin if not provided)")
    .option("--prompt-file <path>", "Custom prompt template file")
    .action(async (options) => {
      try {
        const { setupServices } = await import("./services");
        await setupServices();
        const chatService = getChatService();
        const config = getConfig();
        let input = options.input;

        if (!input && !options.promptFile) {
          input = await readStdin();
        }

        input = readPromptFile(options.promptFile, input);

        if (!input) {
          console.error(
            "Error: No question provided. Use --input flag, pipe input via stdin, or provide --prompt-file."
          );
          process.exit(1);
        }

        const askModule = new AskModule();
        await askModule.initialize(chatService);
        await askModule.processAIQuery(input, {
          plugins: config.plugins.enabled,
          currentModel: options.model,
          currentProvider: options.provider,
          chatHistory: [],
        });
      } catch (error) {
        console.error("Error asking AI:", error);
        process.exit(1);
      }
    });
}

export function addSetupCommand(program: Command, getChatService: () => any): void {
  program
    .command("setup")
    .description("Ask the agent to configure knowhow")
    .action(async () => {
      try {
        const { setupServices } = await import("./services");
        await setupServices();
        const chatService = getChatService();
        const agentModule = new AgentModule();
        await agentModule.initialize(chatService);
        const setupModule = new SetupModule(agentModule);
        await setupModule.initialize(chatService);
        await setupModule.handleSetupCommand([]);
      } catch (error) {
        console.error("Error running agent:", error);
        process.exit(1);
      }
    });
}

export function addSearchCommand(program: Command): void {
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
        const { setupServices } = await import("./services");
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
}

export function addSessionsCommand(program: Command, getChatService: () => any): void {
  program
    .command("sessions")
    .description("Manage agent sessions from CLI")
    .option(
      "--all",
      "Show all historical sessions (default: current process only)"
    )
    .option("--csv", "Output sessions as CSV")
    .action(async (options) => {
      try {
        const chatService = getChatService();
        const agentModule = new AgentModule();
        await agentModule.initialize(chatService);
        const sessionsModule = new SessionsModule(agentModule);
        await sessionsModule.initialize(chatService);
        await sessionsModule.logSessionTable(
          options.all || false,
          options.csv || false,
          true
        );
      } catch (error) {
        console.error("Error listing sessions:", error);
        process.exit(1);
      }
    });
}
