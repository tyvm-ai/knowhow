import * as path from "path";
import * as os from "os";

import { getConfig, getGlobalConfig } from "../../config";
import { KnowhowModule, ModuleContext } from "./types";
import { services } from "../";
import { toUniqueArray } from "../../utils";

export class ModulesService {
  async getDefaultContext() {
    return { ...services() };
  }

  async overrideDefaultContext(overrides: Partial<ModuleContext>) {
    const defaultContext = await this.getDefaultContext();
    return { ...defaultContext, ...overrides };
  }

  async loadModulesFrom(
    config: { modules: string[] } & any,
    context?: Partial<ModuleContext>
  ) {
    // If no context provided, fall back to global singletons
    if (!context) {
      context = { ...(await this.getDefaultContext()) };
    }

    const allModulePaths = config.modules;

    // Search paths: .knowhow/node_modules first (where `knowhow modules install`
    // puts packages), then cwd node_modules, then global node_modules.
    // This allows modules installed via `knowhow modules install` to be found
    // even when knowhow itself is installed globally.
    const cwdPaths = (require as any).resolve
      ? require.resolve.paths?.("") || []
      : [];
    const resolvePaths = [
      path.join(process.cwd(), ".knowhow", "node_modules"),
      path.join(os.homedir(), ".knowhow", "node_modules"),
      path.join(process.cwd(), "node_modules"),
      ...cwdPaths,
    ];

    for (const modulePath of allModulePaths) {
      // Resolve relative paths relative to process.cwd() so that paths like
      // "../../packages/knowhow-module-load-webpage" in knowhow.json work
      // regardless of where the compiled output lives.
      let resolvedPath: string;
      if (modulePath.startsWith(".")) {
        resolvedPath = path.resolve(process.cwd(), modulePath);
      } else {
        // For npm package names, try resolving from cwd first so locally-installed
        // modules are found even when knowhow is installed globally.
        try {
          resolvedPath = require.resolve(modulePath, { paths: resolvePaths });
        } catch {
          resolvedPath = modulePath; // fall back to normal require resolution
        }
      }
      const rawModule = require(resolvedPath);
      const importedModule = (rawModule.default || rawModule) as KnowhowModule;
      context.Events?.log(
        "ModulesService",
        `🔌 Loading module: ${modulePath} (resolved: ${resolvedPath})`
      );
      await importedModule.init({
        config,
        cwd: process.cwd(),
        context: context as ModuleContext,
      });
      context.Events?.log(
        "ModulesService",
        `✅ Module initialized: ${modulePath} (tools: ${importedModule.tools.length}, agents: ${importedModule.agents.length}, plugins: ${importedModule.plugins.length}, clients: ${importedModule.clients.length})`
      );

      // Only register tools/agents/plugins/clients if the relevant services
      // are available in context (they may not be during early CLI command registration)
      if (context.Agents) {
        for (const agent of importedModule.agents) {
          context.Agents.registerAgent(agent);
        }
      }

      if (context.Tools) {
        for (const tool of importedModule.tools) {
          context.Tools.addTool(tool.definition);
          context.Tools.setFunction(
            tool.definition.function.name,
            tool.handler
          );
        }
      }

      if (context.Plugins) {
        for (const plugin of importedModule.plugins) {
          context.Plugins.registerPlugin(
            plugin.name,
            new plugin.plugin(context as any)
          );
        }
      }

      if (context.Clients) {
        for (const client of importedModule.clients) {
          context.Clients.registerClient(client.provider, client.client);
          context.Clients.registerModels(client.provider, client.models);
        }
      }
    }
  }

  async loadModulesFromConfig(context?: ModuleContext) {
    const config = await getConfig();

    const globalConfig = await getGlobalConfig();
    const allModulePaths = [
      ...(globalConfig.modules || []),
      ...(config.modules || []),
    ];

    return this.loadModulesFrom(
      { ...config, modules: toUniqueArray(allModulePaths) },
      context
    );
  }
}
