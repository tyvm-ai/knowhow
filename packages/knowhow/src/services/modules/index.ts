import * as path from "path";
import * as os from "os";
import * as Module from "module";

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

    // Prepend the global knowhow install's own node_modules to Node's global module
    // search paths so that locally-installed modules (loaded from .knowhow/node_modules)
    // that depend on @tyvm/knowhow resolve to the current global version rather than
    // a stale bundled copy.
    const globalKnowhowNodeModules = path.join(__dirname, "../../../../node_modules");
    const globalPaths = (Module as any).globalPaths as string[];
    if (globalPaths && !globalPaths.includes(globalKnowhowNodeModules)) {
      globalPaths.unshift(globalKnowhowNodeModules);
    }

    const allModulePaths = config.modules;

    // Search paths: local .knowhow/node_modules first (where `knowhow modules install`
    // puts packages for this project), then global ~/.knowhow/node_modules, and finally
    // cwd/node_modules as a last resort. Putting cwd/node_modules last avoids accidentally
    // picking up workspace-symlinked dev versions of modules (e.g. when running knowhow
    // from within the knowhow monorepo itself) instead of the properly-installed version.
    const resolvePaths = [
      path.join(process.cwd(), ".knowhow", "node_modules"),
      path.join(os.homedir(), ".knowhow", "node_modules"),
      path.join(process.cwd(), "node_modules"),
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

      let importedModule: KnowhowModule;
      try {
        const rawModule = require(resolvedPath);
        importedModule = (rawModule.default || rawModule) as KnowhowModule;
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
      } catch (err: any) {
        process.stderr.write(
          `\n⚠️  Failed to load module "${modulePath}": ${err.message}\n` +
          `   Run "knowhow modules setup --global" or "knowhow modules install ${modulePath} --global" to fix this.\n\n`
        );
        continue;
      }
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
