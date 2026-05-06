import { getConfig, getGlobalConfig } from "../../config";
import { KnowhowModule, ModuleContext } from "./types";
import { ToolsService } from "../Tools";
import { services } from "../";
import * as path from "path";

export class ModulesService {
  async loadModulesFromConfig(context?: ModuleContext) {
    const config = await getConfig();

    // If no context provided, fall back to global singletons
    if (!context) {
      const { Clients, Plugins, Agents, Tools, Embeddings, MediaProcessor } = services();
      context = {
        Agents,
        Embeddings,
        Plugins,
        Clients,
        Tools,
        MediaProcessor,
      };
    }

    // Use the toolsService from context
    const toolsService = context.Tools;
    const agentService = context.Agents;
    const pluginService = context.Plugins;
    const clients = context.Clients;

    // Load from global config (~/.knowhow/knowhow.json) first, then local config
    const globalConfig = await getGlobalConfig();
    const allModulePaths = [
      ...(globalConfig.modules || []),
      ...(config.modules || []),
    ];

    for (const modulePath of allModulePaths) {
      // Resolve relative paths relative to process.cwd() so that paths like
      // "../../packages/knowhow-module-load-webpage" in knowhow.json work
      // regardless of where the compiled output lives.
      const resolvedPath = modulePath.startsWith(".")
        ? path.resolve(process.cwd(), modulePath)
        : modulePath;
      const rawModule = require(resolvedPath);
      const importedModule = (rawModule.default || rawModule) as KnowhowModule;
      console.log(`🔌 Loading module: ${modulePath} (resolved: ${resolvedPath})`);
      await importedModule.init({ config, cwd: process.cwd(), context });
      console.log(`✅ Module initialized: ${modulePath} (tools: ${importedModule.tools.length}, agents: ${importedModule.agents.length}, plugins: ${importedModule.plugins.length}, clients: ${importedModule.clients.length})`);

      for (const agent of importedModule.agents) {
        agentService.registerAgent(agent);
      }

      for (const tool of importedModule.tools) {
        toolsService.addTool(tool.definition);
        toolsService.setFunction(tool.definition.function.name, tool.handler);
      }

      for (const plugin of importedModule.plugins) {
        const pluginContext = {
          Agents: agentService,
          Clients: clients,
          Tools: toolsService,
          Plugins: pluginService,
          ...(context.MediaProcessor ? { MediaProcessor: context.MediaProcessor } : {}),
        };
        pluginService.registerPlugin(plugin.name, new plugin.plugin(pluginContext as any));
      }

      for (const client of importedModule.clients) {
        clients.registerClient(client.provider, client.client);
        clients.registerModels(client.provider, client.models);
      }
    }

    // Also load plugins directly from config's pluginPackages map
    if (pluginService) {
      await pluginService.loadPluginsFromConfig(config);
      await pluginService.loadPluginsFromConfig(globalConfig);
    }
  }
}
