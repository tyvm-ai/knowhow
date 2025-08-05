#!/usr/bin/env node
import "source-map-support/register";
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

async function setupServices() {
  const { Tools, Agents, Mcp, Clients } = services();
  const { Researcher, Developer, Patcher } = agents();
  Agents.registerAgent(Researcher);
  Agents.registerAgent(Patcher);
  Agents.registerAgent(Developer);
  Agents.loadAgentsFromConfig(services());

  Tools.defineTools(includedTools, allTools);

  await Mcp.connectToConfigured(Tools);
  await Clients.registerConfiguredModels();
}

async function main() {
  const program = new Command();
  
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
    .action(async () => {
      await login();
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