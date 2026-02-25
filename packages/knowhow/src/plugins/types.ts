import { Embeddable, MinimalEmbedding } from "../types";
import { AgentService, EventService, ToolsService } from "../services";
import { AIClient } from "../clients";
import { PluginService } from "./plugins";

export interface PluginMeta {
  key: string;
  name: string;
  description?: string;
  requires?: string[]; // Environment variables required
}

export interface Plugin {
  callMany(userInput?: string): Promise<string>;
  call(userInput?: string): Promise<string>;
  embed(userInput?: string): Promise<MinimalEmbedding[]>;
  enable(): void;
  disable(): void;
  isEnabled(): boolean;

  meta: PluginMeta;
}

export interface PluginContext {
  Agents?: AgentService;
  Events?: EventService;
  Clients?: AIClient;
  Tools?: ToolsService;
  Plugins?: PluginService;
}
