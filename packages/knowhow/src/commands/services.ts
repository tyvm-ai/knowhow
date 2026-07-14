import { includedTools } from "../agents/tools/list";
import * as allTools from "../agents/tools";
import { LazyToolsService, services, MinimalToolsService } from "../services";
import { agents } from "../agents";
import { ModulesService } from "../services/modules";
import { Behaviors } from "../services/BehaviorsService";
import { getConfig } from "../config";

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
  } = services();


  // cli uses LazyTools to keep context slim
  const Tools = new LazyToolsService();

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

  // Load skills/behaviors from disk into memory (respects config.skills file list if set)
  let config: { skills?: string[] } = {};
  try { config = await getConfig(); } catch { /* no config file */ }
  Behaviors.initFromDisk(config.skills);

  Agents.setAgentContext(agentContext);

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
  await modulesService.loadModulesFromConfig({
    Agents,
    Embeddings,
    Plugins,
    Clients,
    Tools,
    MediaProcessor,
    Events
  });

  return { Tools, Clients };
}
