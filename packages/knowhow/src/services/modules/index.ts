import * as path from "path";
import * as os from "os";
import * as Module from "module";

import { getConfig, getGlobalConfig } from "../../config";
import { KnowhowModule, ModuleContext } from "./types";
import { services } from "../";
import { toUniqueArray } from "../../utils";

/**
 * Module resolution search paths.
 *
 * A module's resolution order depends on WHICH config declared it:
 *
 * - Modules declared in the GLOBAL config should resolve against the global
 *   install's node_modules (~/.knowhow/node_modules) — i.e. what's installed
 *   alongside the global config. We still fall back to cwd paths as a last
 *   resort so a globally-declared module can still be found if it only exists
 *   locally.
 *
 * - Modules declared in the LOCAL config should resolve against the local
 *   project first (cwd/.knowhow/node_modules), then the global config's
 *   node_modules (~/.knowhow/node_modules), then cwd/node_modules.
 */
function localResolvePaths(): string[] {
  return [
    path.join(process.cwd(), ".knowhow", "node_modules"),
    path.join(os.homedir(), ".knowhow", "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];
}

function globalResolvePaths(): string[] {
  return [
    path.join(os.homedir(), ".knowhow", "node_modules"),
    path.join(process.cwd(), ".knowhow", "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];
}

export class ModulesService {
  private _loadedModules: {
    modulePath: string;
    resolvedPath: string;
    module: KnowhowModule;
    params: any;
  }[] = [];

  async getDefaultContext() {
    return { ...services() };
  }

  async overrideDefaultContext(overrides: Partial<ModuleContext>) {
    const defaultContext = await this.getDefaultContext();
    return { ...defaultContext, ...overrides };
  }

  async loadModulesFrom(
    config: { modules: string[] } & any,
    context?: Partial<ModuleContext>,
    resolvePaths: string[] = localResolvePaths()
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

    // `resolvePaths` (passed in by the caller) determines the search-path order.
    // Global-config modules resolve against ~/.knowhow/node_modules first; local-config
    // modules resolve against cwd/.knowhow/node_modules first. See localResolvePaths()
    // and globalResolvePaths() above.

    // Two-phase load:
    //   Phase 1 (register): resolve + require EVERY module and run its optional
    //     `register()`, which may (a) register CLI subcommands on Program and
    //     (b) inject shared services into `context` (e.g. `ComputerUse`) so that
    //     sibling/adapter modules loaded later can consume them.
    //   Phase 2 (init): run every loaded module's `init()`, now that all
    //     services registered during phase 1 are present. This lets, e.g., a
    //     `-nutjs` adapter module register a driver against the base
    //     computer-use service during phase 1, and the base module resolve the
    //     best driver during phase 2.
    const loadedModules: {
      modulePath: string;
      resolvedPath: string;
      module: KnowhowModule;
    }[] = [];

    for (const modulePath of allModulePaths) {
      // Build an ordered list of candidate resolutions for this module.
      // Relative paths resolve to a single candidate (relative to cwd), while
      // npm package names get one candidate per search path so we can fall
      // back to the global install if a locally-symlinked (e.g. workspace dev)
      // build fails to load (wrong Node ABI, broken build, etc.).
      const candidates: string[] = [];
      if (modulePath.startsWith(".")) {
        candidates.push(path.resolve(process.cwd(), modulePath));
      } else {
        // For npm package names, resolve against each search path individually
        // (in priority order) so each becomes its own fallback candidate.
        for (const searchPath of resolvePaths) {
          try {
            const resolved = require.resolve(modulePath, {
              paths: [searchPath],
            });
            if (!candidates.includes(resolved)) candidates.push(resolved);
          } catch {
            // this search path doesn't have the module — try the next one
          }
        }
        // Finally, normal require resolution as a last resort.
        try {
          const resolved = require.resolve(modulePath);
          if (!candidates.includes(resolved)) candidates.push(resolved);
        } catch {
          // ignore — will fall through to the bare name below
        }
        if (candidates.length === 0) candidates.push(modulePath);
      }

      // Try each candidate in order. Only if EVERY candidate fails to load do
      // we surface an error — a failure on one candidate (e.g. a stale local
      // workspace build) should silently fall back to the next (e.g. the
      // global install).
      let importedModule: KnowhowModule;
      let loaded = false;
      let selectedResolvedPath = modulePath;
      const errors: { candidate: string; error: Error }[] = [];
      for (const resolvedPath of candidates) {
        try {
          const rawModule = require(resolvedPath);
          importedModule = (rawModule.default || rawModule) as KnowhowModule;
          context.Events?.log(
            "ModulesService",
            `🔌 Loading module: ${modulePath} (resolved: ${resolvedPath})`
          );
          // Phase 1: register (optional). Injects services into `context` and
          // registers CLI commands. Must be idempotent (may run in the early
          // Program-only CLI phase AND the full-services phase).
          if (typeof importedModule.register === "function") {
            await importedModule.register({
              config,
              cwd: process.cwd(),
              context: context as ModuleContext,
            });
          }
          selectedResolvedPath = resolvedPath;
          loaded = true;
          break;
        } catch (err: any) {
          errors.push({ candidate: resolvedPath, error: err });
          // try the next candidate
        }
      }

      if (!loaded) {
        // All candidates failed — report the last (most fully-resolved) error.
        const last = errors[errors.length - 1];
        const detail = last
          ? `${last.error.message}`
          : "no resolvable module found";
        process.stderr.write(
          `\n⚠️  Failed to load module "${modulePath}": ${detail}\n` +
          `   Tried: ${candidates.join(", ") || "(none)"}\n` +
          `   Run "knowhow modules setup --global" or "knowhow modules install ${modulePath} --global" to fix this.\n\n`
        );
        continue;
      }
      loadedModules.push({
        modulePath,
        resolvedPath: selectedResolvedPath,
        module: importedModule,
      });
    }

    // Phase 2: init every successfully-loaded module now that all `register`
    // phases have run and injected their services into `context`.
    for (const { modulePath, resolvedPath, module: importedModule } of loadedModules) {
      const initParams = { config, cwd: process.cwd(), context: context as ModuleContext };
      try {
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
          `\n⚠️  Failed to init module "${modulePath}": ${err?.message || err}\n\n`
        );
        continue;
      }
      this._loadedModules.push({ modulePath, resolvedPath, module: importedModule, params: initParams });

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

  /**
   * Call `destroy()` on every successfully-initialized module, in reverse
   * initialization order (last-in, first-out). Errors are caught and logged
   * so one broken module does not prevent others from cleaning up.
   */
  async destroyModules() {
    const toDestroy = [...this._loadedModules].reverse();
    // Clear first so repeated shutdown/reload attempts cannot destroy twice.
    this._loadedModules = [];
    for (const { modulePath, resolvedPath, module: mod, params } of toDestroy) {
      if (typeof mod.destroy === "function") {
        try {
          await mod.destroy(params);
        } catch (err: any) {
          process.stderr.write(
            `\n⚠️  Error in module destroy "${modulePath}": ${err?.message || err}\n\n`
          );
        }
      }
      // Re-require the entry point so source/configuration changes are visible.
      if (require.cache[resolvedPath]) {
        delete require.cache[resolvedPath];
      }
    }
  }

  async loadModulesFromConfig(context?: ModuleContext) {
    const config = await getConfig();

    const globalConfig = await getGlobalConfig();

    const globalModules = toUniqueArray(globalConfig.modules || []);
    // Local modules already loaded globally shouldn't be loaded again (a module
    // that adds a CLI command would throw "already have command"). De-dupe local
    // against global.
    const localModules = toUniqueArray(config.modules || []).filter(
      (m) => !globalModules.includes(m)
    );

    // Load global-config modules resolving against the global install's
    // node_modules (~/.knowhow/node_modules) first.
    if (globalModules.length > 0) {
      await this.loadModulesFrom(
        { ...config, modules: globalModules },
        context,
        globalResolvePaths()
      );
    }

    // Load local-config modules resolving against the local project's
    // node_modules (cwd/.knowhow/node_modules) first.
    if (localModules.length > 0) {
      await this.loadModulesFrom(
        { ...config, modules: localModules },
        context,
        localResolvePaths()
      );
    }
  }
}
