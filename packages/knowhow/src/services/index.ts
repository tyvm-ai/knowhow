import { AIClient, Clients } from "../clients";
import { AgentService } from "./AgentService";
import { EventService } from "./EventService";
import { FlagsService } from "./flags";
import { EmbeddingsService } from "./EmbeddingsService";
import { KnowhowSimpleClient } from "./KnowhowClient";
import { McpService } from "./Mcp";
import { S3Service } from "./S3";
import { ToolsService } from "./Tools";
import { CliPluginService, PluginService } from "../plugins/plugins";
import { DockerService } from "./DockerService";
import { AgentSyncKnowhowWeb } from "./AgentSyncKnowhowWeb";
import { AgentSyncFs } from "./AgentSyncFs";
import { SessionManager } from "./SessionManager";
import { TaskRegistry } from "./TaskRegistry";
import { MediaProcessorService } from "./MediaProcessorService";
import { BehaviorsService } from "./BehaviorsService";
import { RuntimeReloadService } from "./RuntimeReloadService";
import { ExtensionsService } from "./ExtensionsService";

import { ConversionService } from "./conversion/ConversionService";
import { TracingService } from "./TracingService";

export * from "./AgentService";
export * from "./EventService";
export * from "./flags";
export * from "./EmbeddingsService";
export * from "./S3";
export * from "./Tools";
export * from "./LazyToolsService";
export * from "./MinimalToolsService";
export * as MCP from "./Mcp";
export * from "./EmbeddingService";
export * from "./DockerService";
export * from "./MediaProcessorService";
export * from "./AgentSyncKnowhowWeb";
export * from "./AgentSyncFs";
export * from "./SessionManager";
export * from "./TaskRegistry";
export * from "./SyncedAgentWatcher";
export * from "./SyncerService";
export * from "./watchers";
export { Clients } from "../clients";
export * from "../util/Trace";
export { TracingService } from "./TracingService";
export type { TracerImpl, SpanHandle } from "./TracingService";
export * from "./conversion";
export * from "./RuntimeReloadService";
export * from "./ExtensionsService";
export { BehaviorsService } from "./BehaviorsService";

let Singletons = {} as {
  Tools: ToolsService;
  Events: EventService;
  Agents: AgentService;
  Tracing: typeof TracingService;
  Embeddings: EmbeddingsService;
  Flags: FlagsService;
  Mcp: McpService;
  AwsS3: S3Service;
  Docker: DockerService;
  knowhowApiClient: KnowhowSimpleClient;
  Plugins: PluginService;
  Clients: AIClient;
  MediaProcessor: MediaProcessorService;
  Conversion: ConversionService;
  Behaviors: BehaviorsService;
  RuntimeReload: RuntimeReloadService;
  Extensions: ExtensionsService;
};

export const services = (): typeof Singletons => {
  if (Object.keys(Singletons).length === 0) {
    const Tools = new ToolsService();
    const Events = new EventService();
    const Agents = new AgentService(Tools, Events);
    const MediaProcessor = new MediaProcessorService(Clients);
    const Behaviors = new BehaviorsService();
    const Conversion = new ConversionService(Clients, MediaProcessor);
    const Plugins = new CliPluginService({
      Agents,
      Events,
      Tools,
      Clients,
    });

    Singletons = {
      Agents,
      AwsS3: new S3Service(),
      Tracing: TracingService,
      Clients,
      Docker: new DockerService(),
      Events,
      Embeddings: new EmbeddingsService(),
      Flags: new FlagsService(),
      Mcp: new McpService(),
      MediaProcessor,
      Conversion,
      Plugins,
      Tools,
      knowhowApiClient: new KnowhowSimpleClient(),
      Behaviors,
      RuntimeReload: new RuntimeReloadService(),
      Extensions: new ExtensionsService(),
    };

    Singletons.Tools.setContext({
      Agents,
      Events,
      Plugins,
      Clients,
      Behaviors,
    });
  }

  return Singletons;
};
