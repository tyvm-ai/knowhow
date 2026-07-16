#!/usr/bin/env node --no-node-snapshot
import { Command } from "commander";
import { version } from "../package.json";
import { logger } from "./logger";
import { migrateConfig } from "./config";
import { getConfig, getGlobalConfig } from "./config";
import { getEnabledPlugins } from "./types";
import { CliChatService } from "./chat/CliChatService";
import { ModulesService } from "./services/modules";

// Command registrars
import { addModulesCommand } from "./commands/modules";
import { addMcpCommands } from "./commands/mcp";
import {
  addWorkerCommand,
  addWorkersCommand,
  addTunnelCommand,
  addFilesCommand,
  addCloudWorkerCommand,
} from "./commands/workers";
import {
  addAgentCommand,
  addAskCommand,
  addSetupCommand,
  addSearchCommand,
  addSessionsCommand,
} from "./commands/agent";
import {
  addInitCommand,
  addLoginCommand,
  addUpdateCommand,
  addGenerateCommand,
  addEmbedCommands,
  addUploadCommand,
  addDownloadCommand,
  addChatCommand,
  addGithubCredentialsCommand,
} from "./commands/misc";
import { addConvertCommand } from "./commands/convert";
import { addReplayCommand } from "./commands/replay";
import { addBehaviorsCommand } from "./commands/behaviors";
import { addSkillsCommand } from "./commands/skills";
import { addAgentsCommand } from "./commands/agents";

// Handle unhandled promise rejections gracefully — particularly from MCP SDK
// which fires errors via event emitters that can bypass Promise.allSettled.
// Without this, a single failing MCP server (e.g. expired Notion token) will
// crash the entire CLI with an unhandled rejection.
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  // Only warn — don't exit. The MCP connect errors are recoverable;
  // the server will simply be unavailable but others continue working.
  console.warn(`⚠ Unhandled MCP/async error (non-fatal): ${message}`);
});

async function main() {
  const program = new Command();

  // Install console overload early so ALL output (including third-party modules)
  // goes through our logger closure — respects silence() for clean-stdout commands.
  logger.installConsoleOverload();

  // Silence immediately if this is a clean-stdout command (e.g. git credential helpers).
  // Module loading happens before parseAsync, so we must silence before that point.
  const rawArgs = process.argv.slice(2);
  const SILENT_COMMANDS = ["github-credentials"];
  if (rawArgs.some((a) => SILENT_COMMANDS.includes(a))) {
    logger.silence();
  }

  await migrateConfig();
  const config = await getConfig();
  const chatService = new CliChatService(getEnabledPlugins(config.plugins));

  // Lazily expose chatService and config to commands that need them
  const getChatService = () => chatService;
  const getConfigFn = () => config;

  program
    .name("knowhow")
    .description("AI CLI with plugins and agents")
    .version(version);

  // Register all commands
  addInitCommand(program);
  addLoginCommand(program);
  addUpdateCommand(program);
  addGenerateCommand(program);
  addEmbedCommands(program);
  addUploadCommand(program);
  addDownloadCommand(program);
  addChatCommand(program);
  addAgentCommand(program, getChatService);
  addAskCommand(program, getChatService, getConfigFn);
  addSetupCommand(program, getChatService);
  addSearchCommand(program);
  addSessionsCommand(program, getChatService);
  addWorkerCommand(program);
  addWorkersCommand(program);
  addTunnelCommand(program);
  addFilesCommand(program);
  addCloudWorkerCommand(program);
  addGithubCredentialsCommand(program);
  addModulesCommand(program);
  addMcpCommands(program);
  addConvertCommand(program);
  addReplayCommand(program);
  addBehaviorsCommand(program);
  addSkillsCommand(program);
  addAgentsCommand(program);

  // Load global modules early (before parse) so they can register CLI subcommands.
  // We pass only the Program in context — no services are spun up at this stage.
  // Each module's command action is responsible for calling setupServices() as needed.
  try {
    const globalConfig = await getGlobalConfig();
    const allModulePaths = [
      ...(globalConfig.modules || []),
      ...(config.modules || []),
    ];
    if (allModulePaths.length) {
      const earlyModulesService = new ModulesService();
      await earlyModulesService.loadModulesFrom(
        { ...config, modules: allModulePaths },
        {
          Program: program,
        }
      );
    }
  } catch (e) {
    // Non-fatal: if global modules fail to load for CLI registration, continue
  }

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
