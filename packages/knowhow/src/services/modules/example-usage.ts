import { AgentService } from "../AgentService";
import { EventService } from "../EventService";
import { ToolsService } from "../Tools";
import { PluginService } from "../../plugins/plugins";
import { AIClient } from "../../clients";
import { ModulesService } from "./index";
import { ModuleContext } from "./types";

/**
 * Example of how to use ModulesService with dependency injection
 * instead of relying on global singletons
 */
export async function loadModulesWithCustomContext() {
  // Create your own service instances
  const toolsService = new ToolsService();
  const eventService = new EventService();
  const agentService = new AgentService(toolsService, eventService);
  const pluginService = new PluginService();
  const clients = new AIClient();

  // Set up the tools service context
  toolsService.setContext({
    agentService,
    eventService,
    pluginService,
    clients,
  });

  // Create the module context
  const moduleContext: ModuleContext = {
    agentService,
    pluginService,
    clients,
    toolsService,
  };

  // Load modules using the custom context
  const modulesService = new ModulesService();
  await modulesService.loadModulesFromConfig(moduleContext);

  // Now all modules are loaded into your custom service instances
  // instead of the global singletons
  return {
    agentService,
    pluginService,
    clients,
    toolsService,
  };
}

/**
 * Example of loading modules with global singletons (backward compatibility)
 */
export async function loadModulesWithGlobalSingletons() {
  const modulesService = new ModulesService();
  
  // When no context is provided, it falls back to global singletons
  await modulesService.loadModulesFromConfig();
}