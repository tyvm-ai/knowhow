#!/usr/bin/env node
import "source-map-support/register";
import { generate, embed, upload, chat } from "./index";
import { init } from "./config";

import { download, purge } from ".";
import { Agents } from "./services/AgentService";
import { Researcher } from "./agents/researcher/researcher";
import { Patcher } from "./agents/patcher/patcher";
import { Vimmer } from "./agents/vim/vim";
import { Developer } from "./agents/developer/developer";
import { Tools } from "./services";
import { includedTools } from "./agents/tools/list";
import * as allTools from "./agents/tools";
import { Mcp } from "./services/Mcp";
import { login } from "./login";
import { worker } from "./worker";
import { Clients } from "./clients";

const command = process.argv[2];

async function main() {
  Agents.registerAgent(Researcher);
  Agents.registerAgent(Patcher);
  Agents.registerAgent(Developer);
  Agents.loadAgentsFromConfig();

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
