import { includedTools } from "../agents/tools/list";
import * as allTools from "../agents/tools";
import { LazyToolsService, services, MinimalToolsService, TracingService } from "../services";
import { agents } from "../agents";
import { ModulesService } from "../services/modules";
import { getConfig, getConfigSync } from "../config";
import { authenticateWithKey } from "../auth/keyAuth";

/**
 * Shared service setup used by commands that need full services (chat, agent, worker, etc.)
 */
export async function setupServices() {
  const {
    Agents,
    Mcp,
    Clients,
    Tools: AllTools,
    Embeddings,
    Plugins,
    Events,
    MediaProcessor,
    Behaviors,
    RuntimeReload,
    Extensions,
  } = services();

  await Plugins.refreshConfiguredState();
  // cli uses LazyTools to keep context slim
  const Tools = new LazyToolsService();
  await Behaviors.initFromConfig();

  // Give LazyToolsService the same context that ToolService had
  Tools.setContext({
    ...AllTools.getContext(),
  });

  const agentContext: import("../agents/base/base").AgentContext = {
    ...services(),
    Tools,
  };

  const { Researcher, Developer, Patcher, Setup } = agents({
    ...agentContext,
  });

  Agents.registerAgent(Researcher);
  Agents.registerAgent(Patcher);
  Agents.registerAgent(Developer);
  Agents.registerAgent(Setup);
  Agents.loadAgentsFromConfig(agentContext);

  Tools.defineTools(includedTools, allTools);

  Tools.addContext("Mcp", Mcp);

  // The `agentCall` tool + function are registered by AgentService on the
  // global ToolsService (AllTools), not on the LazyToolsService we build here.
  // Copy it across so agents/scripts using this Tools instance can delegate to
  // other agents via agentCall (matching startAgentTask availability).
  try {
    const agentCallDef = AllTools.getTool?.("agentCall");
    const agentCallFn = AllTools.getFunction?.("agentCall");
    if (agentCallDef) Tools.addTool(agentCallDef);
    if (agentCallFn) Tools.setFunction("agentCall", agentCallFn);
  } catch (_) {
    // Non-fatal: if agentCall isn't registered yet, agents can still use
    // startAgentTask for delegation.
  }

  Agents.setAgentContext(agentContext);

  // Refresh authentication before MCP transports, model clients, or remote
  // sync modules can read the project JWT file.
  try {
    const startupConfig = getConfigSync();
    if (startupConfig.orgId && !process.env.KNOWHOW_JWT) {
      const refreshed = await authenticateWithKey(
        startupConfig.orgId,
        process.env.KNOWHOW_API_URL || "https://api.knowhow.tyvm.ai",
        startupConfig.cliIdentityPath
      );
      if (!refreshed) {
        console.warn(
          `⚠ Could not renew the Knowhow session: no available CLI identity is registered ` +
          `for configured organization ${startupConfig.orgId}. Run \`knowhow login\` to select ` +
          `an organization and register the global identity.`
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠ Could not renew the Knowhow session before startup: ${message}`);
  }

  console.log("🔌 Connecting to MCP...");
  try {
    await Mcp.connectToConfigured(Tools);
  } catch (mcpError) {
    const msg = mcpError instanceof Error ? mcpError.message : String(mcpError);
    console.warn(
      `⚠ Some MCP servers failed to connect (continuing without them): ${msg}`
    );
  }

  console.log("Connecting to clients...");
  await Clients.registerConfiguredModels();
  console.log("✓ Services are set up and ready to go!");

  console.log("📦 Loading modules from config...");
  const modulesService = new ModulesService();
  const moduleContext = {
    Agents,
    Embeddings,
    Plugins,
    Clients,
    Tools,
    MediaProcessor,
    Behaviors,
    Events,
    Tracing: TracingService,
    Extensions,
  };

  // Call destroy() on all modules when the process is shutting down so they
  // can flush buffers (e.g. OTEL spans), close connections, etc.
  const destroyAll = async () => {
    await modulesService.destroyModules();
  };
  process.on("beforeExit", destroyAll);
  process.on("SIGINT", async () => {
    await destroyAll();
    process.exit(0);
  });
  await modulesService.loadModulesFromConfig(moduleContext);

  RuntimeReload.configure(async () => {
    await modulesService.destroyModules();
    await Plugins.refreshConfiguredState();
    await Mcp.closeAll();

    Tools.resetTools();
    Tools.defineTools(includedTools, allTools);
    try {
      const agentCallDef = AllTools.getTool?.("agentCall");
      const agentCallFn = AllTools.getFunction?.("agentCall");
      if (agentCallDef) Tools.addTool(agentCallDef);
      if (agentCallFn) Tools.setFunction("agentCall", agentCallFn);
    } catch (_) {}

    await Behaviors.initFromConfig();
    await Mcp.connectToConfigured(Tools);
    await Clients.registerConfiguredModels();
    await modulesService.loadModulesFromConfig(moduleContext);

    const config = await getConfig();
    return {
      tools: Tools.getTools().length,
      mcps: (config.mcps || []).length,
      modules: (config.modules || []).length,
    };
  });
  process.on("SIGTERM", async () => {
    await destroyAll();
    process.exit(0);
  });

  return { Tools, Clients, modulesService };
}
