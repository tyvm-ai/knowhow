#!/usr/bin/env node
import "source-map-support/register";
import { generate, embed, upload, chat } from "./index";
import { init } from "./config";

import { download, purge } from ".";
import { includedTools } from "./agents/tools/list";
import * as allTools from "./agents/tools";
import { services } from "./services";
import { login } from "./login";
import { worker } from "./worker";
import { agents } from "./agents";

const command = process.argv[2];

async function main() {
  const { Tools, Agents, Mcp, Clients } = services();
  const { Researcher, Developer, Patcher } = agents();
  Agents.registerAgent(Researcher);
  Agents.registerAgent(Patcher);
  Agents.registerAgent(Developer);
  Agents.loadAgentsFromConfig(services());

  Tools.defineTools(includedTools, allTools);

  await Mcp.connectToConfigured(Tools);
  await Clients.registerConfiguredModels();

  // VIMMER is disabled for now
  // Agents.registerAgent(Vimmer);

  switch (command) {
    case "init":
      await init();
      break;
    case "login":
      await login();
      break;
    case "generate":
      await generate();
      break;
    case "embed":
      await embed();
      break;
    case "embed:purge":
      await purge(process.argv[3]);
      break;
    case "upload":
      await upload();
      break;
    case "download":
      await download();
      break;
    case "chat":
      await chat();
      break;
    case "worker":
      await worker();
      break;
    default:
      console.log(
        "Unknown command. Please use one of the following: init, login, generate, embed, embed:purge, upload, download, chat"
      );
      break;
  }
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
