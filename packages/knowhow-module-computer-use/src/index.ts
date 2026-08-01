import {
  KnowhowModule,
  InitParams,
  ModuleTool,
} from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { ComputerService } from "./ComputerService";
import { RustCoreDriver } from "./drivers/RustCoreDriver";
import { computerToolDefinitions } from "./tools/definitions";
import { registerComputerCli } from "./cli";
import * as computerTools from "./tools";

export { ComputerService } from "./ComputerService";
export { RustCoreDriver } from "./drivers/RustCoreDriver";
export * from "./tools";
export { computerToolDefinitions } from "./tools/definitions";
// `sdk` is an editor/type binding for .knowhow/automations/*.ts files; the
// automation runner replaces its import with the live SDK at execution time.
export { sdk, AutomationSDK, AutomationControl, WindowMatch } from "./automation";

// A single service instance shared across the register + init phases (module
// object is cached by Node, so this persists between the early CLI phase and
// the full-services phase).
let service: ComputerService | null = null;

function getConfigOptions(config: any) {
  const cfg = (config && config.computerUse) || {};
  return {
    driver: cfg.driver && cfg.driver !== "auto" ? cfg.driver : undefined,
    screenshotFormat: cfg.screenshotFormat,
    screenshotScale: cfg.screenshotScale,
  };
}

function getAgentCliOptions(config: any) {
  const cfg = (config && config.computerUse) || {};
  const agent = cfg.agent || {};
  return {
    agentModel: agent.model,
    agentProvider: agent.provider,
    agentName: agent.agentName,
  };
}

// Every computer-use tool is namespaced with a `computerUse` prefix so the
// whole toolset can be enabled with a single glob: enableTools("computerUse*").
const tools: ModuleTool[] = computerToolDefinitions.map((definition) => ({
  name: definition.function.name,
  handler: (computerTools as any)[definition.function.name],
  definition,
}));

const computerUseModule: KnowhowModule = {
  /**
   * Phase 1 — register:
   *   - build the ComputerService and register OUR default Rust-core driver
   *   - inject the service into the shared Tools context as `ComputerUse` so
   *     that (a) tools can read it and (b) ADAPTER modules (e.g.
   *     `@tyvm/knowhow-module-computer-use-nutjs`) can, in THEIR register phase,
   *     call `context.ComputerUse.registerDriver(new NutJsDriver())`.
   *   - register the `knowhow computer` CLI subcommands on Program.
   *
   * Idempotent: safe to run in both the early Program-only CLI phase and the
   * full-services phase.
   */
  async register(params: InitParams) {
    const opts = getConfigOptions(params.config);

    if (!service) {
      service = new ComputerService(opts);
      // Register our own default engine. tryLoad() returns null if the native
      // core can't load, in which case an adapter/fallback driver can still be
      // registered by another module.
      const rust = RustCoreDriver.tryLoad();
      if (rust) service.registerDriver(rust);
    }

    // Inject into Tools context so tools + sibling modules can reach it.
    const ctx = params.context;
    if (ctx?.Tools) {
      const toolCtx = ctx.Tools.getContext();
      if (!toolCtx.ComputerUse) {
        ctx.Tools.setContext({ ...toolCtx, ComputerUse: service });
      }
    }
    // Also expose on the ModuleContext object itself so other modules' register
    // phases can read `context.ComputerUse` directly.
    if (ctx) {
      (ctx as any).ComputerUse = service;
    }

    // Register CLI commands (Program is present in the early phase).
    if (ctx?.Program) {
      registerComputerCli(ctx.Program as any, getAgentCliOptions(params.config));
    }
  },

  /**
   * Phase 2 — init: all register phases have run, so any adapter drivers are
   * now registered. Resolve/select the active driver eagerly so failures
   * surface at startup rather than on first tool call. Non-fatal on failure —
   * the module still loads and reports via `doctor`.
   */
  async init(params: InitParams) {
    if (!service) {
      // register() didn't run for some reason; do a minimal setup.
      await computerUseModule.register!(params);
    }
    try {
      const driver = await service!.getDriver();
      params.context?.Events?.log(
        "computer-use",
        `🖱️  Computer-use active driver: ${driver.name} (registered: ${service!
          .listDrivers()
          .join(", ")})`
      );
    } catch (e: any) {
      params.context?.Events?.log(
        "computer-use",
        `⚠️  No usable computer-use driver: ${e?.message || e}`
      );
    }
  },

  tools,
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default computerUseModule;
