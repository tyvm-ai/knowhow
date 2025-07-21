import { getConfig } from "../../config";
import { KnowhowModule, ModuleContext } from "./types";
import { ToolsService } from "../Tools";
import { services } from "../";
import { EventService } from "../EventService";

export class ModulesService {
  async loadModulesFromConfig(context?: ModuleContext) {
    const config = await getConfig();

    // If no context provided, fall back to global singletons
    if (!context) {
      const { Clients, Plugins, Agents, Tools } = services();
      context = {
        Agents,
        Plugins,
        Clients,
        Tools,
      };
    }

    // Use the toolsService from context
    const toolsService = context.Tools;
    const agentService = context.Agents;
    const pluginService = context.Plugins;
    const clients = context.Clients;

    const modules = config.modules || [];

    for (const modulePath of modules) {
      const importedModule = require(modulePath) as KnowhowModule;
      await importedModule.init({ config, cwd: process.cwd() });

      for (const agent of importedModule.agents) {
        agentService.registerAgent(agent);
      }

      for (const tool of importedModule.tools) {
        toolsService.addTool(tool.definition);
        toolsService.setFunction(tool.definition.function.name, tool.handler);
      }

      for (const plugin of importedModule.plugins) {
        pluginService.registerPlugin(plugin.name, plugin.plugin);
      }

      for (const client of importedModule.clients) {
        clients.registerClient(client.provider, client.client);
        clients.registerModels(client.provider, client.models);
      }
    }
  }
}
