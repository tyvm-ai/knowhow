import { Plugin } from "../../plugins/types";
import { IAgent } from "../../agents/interface";
import { Tool } from "../../clients/types";
import { Config } from "../../types";
import { GenericClient } from "../../clients/types";
import { AgentService } from "../AgentService";
import { PluginService } from "../../plugins/plugins";
import { AIClient } from "../../clients";
import { ToolsService } from "../Tools";

/*
 *
 * A a module should allow the dynamic composition of npm modules that are installed globally by referencing an array of config
 *
 * A module can add new commands to the chat loop, new tools, new agents, new plugins, new clients, new server features etc.
 *
 */
export interface ModuleChatCommand {
  name: string;
  description: string;
  handler: (ctx: any) => void;
}

export interface ModuleTool {
  name: string;
  handler: (...args: any[]) => any;
  definition: Tool;
}

export type ModuleAgent = IAgent;

export type ModulePlugin = { name: string; plugin: Plugin };

export type ModuleClient = {
  client: GenericClient;
  provider: string;
  models: string[];
};

export type InitParams = {
  config: Config;
  cwd: string;
};

export interface ModuleContext {
  Agents: AgentService;
  Plugins: PluginService;
  Clients: AIClient;
  Tools: ToolsService;
}

export interface KnowhowModule {
  init: (params: InitParams) => Promise<void>;
  commands: ModuleChatCommand[];
  tools: ModuleTool[];
  agents: ModuleAgent[];
  plugins: ModulePlugin[];
  clients: ModuleClient[];
}
