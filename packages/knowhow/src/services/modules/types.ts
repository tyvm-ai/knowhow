import { Plugin, PluginContext } from "../../plugins/types";
import { Command } from "commander";
import { IAgent } from "../../agents/interface";
import { Tool } from "../../clients/types";
import { Config } from "../../types";
import { GenericClient } from "../../clients/types";
import { AgentService } from "../AgentService";
import { EmbeddingsService } from "../EmbeddingsService";
import { PluginService } from "../../plugins/plugins";
import { AIClient } from "../../clients";
import { ToolsService } from "../Tools";
import { MediaProcessorService } from "../MediaProcessorService";
import { TunnelHandler } from "@tyvm/knowhow-tunnel";
import { EventService } from "../EventService";
import { ConversionService } from "../conversion/ConversionService";
import { BehaviorsService } from "../BehaviorsService";
import { ComputerUseService } from "./computerUse";
import { ExtensionsService, ModuleExtension } from "../ExtensionsService";

import { TracingService as TracingServiceType } from "../TracingService";
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

export type PluginConstructor = new (context: PluginContext) => Plugin;
export type ModulePlugin = { name: string; plugin: PluginConstructor };

export type ModuleClient = {
  client: GenericClient;
  provider: string;
  models: string[];
};

export type InitParams = {
  config: Config;
  cwd: string;
  context?: ModuleContext;
};

export interface ModuleContext {
  Agents: AgentService;
  Embeddings: EmbeddingsService;
  Plugins: PluginService;
  Clients: AIClient;
  Tools: ToolsService;
  Events: EventService;
  MediaProcessor?: MediaProcessorService;
  Conversion?: ConversionService;
  Tunnel?: TunnelHandler;
  Program?: Command;
  Behaviors?: BehaviorsService;
  ComputerUse?: ComputerUseService;
  Extensions?: ExtensionsService;
  [key: string]: any;
  Tracing?: typeof TracingServiceType;
}

export interface KnowhowModule {
  /**
   * Phase 1 (optional): called first, potentially with ONLY `Program` in
   * context (e.g. during early CLI command registration). Use this to:
   *   - register CLI subcommands on `context.Program`
   *   - inject services into the shared context (e.g.
   *     `context.Tools?.addContext("ComputerUse", svc)`) so that OTHER modules
   *     (or a sibling adapter module) can consume them during their own init.
   *
   * `register` must be side-effect-light and MUST NOT assume the full service
   * graph is present — only `Program` is guaranteed during the early phase.
   * It may be called more than once (early CLI phase + full-services phase);
   * implementations should be idempotent.
   */
  register?: (params: InitParams) => Promise<void>;
  /**
   * Phase 2: called with the full service graph available. Use this to
   * actually connect/start things (open drivers, spin up watchers, read
   * services registered by other modules' `register` phase, etc.).
   */
  init: (params: InitParams) => Promise<void>;
  /**
   * Phase 3 (optional): called when the CLI is shutting down. Use this to
   * cleanly release resources — close connections, flush buffers, stop
   * watchers, etc. Mirror of `init`.
   */
  destroy?: (params: InitParams) => Promise<void>;
  commands: ModuleChatCommand[];
  /** Optional capabilities consumed by core or third-party services. */
  extensions?: ModuleExtension[];
  tools: ModuleTool[];
  agents: ModuleAgent[];
  plugins: ModulePlugin[];
  clients: ModuleClient[];
}
