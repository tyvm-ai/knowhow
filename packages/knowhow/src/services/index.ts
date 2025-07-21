import { Clients } from "../clients";
import { Plugins } from "../plugins/plugins";
import { AgentService } from "./AgentService";
import { EventService } from "./EventService";
import { FlagsService } from "./flags";
import { GitHubService } from "./GitHub";
import { KnowhowSimpleClient } from "./KnowhowClient";
import { McpService } from "./Mcp";
import { S3Service } from "./S3";
import { ToolsService } from "./Tools";

export * from "./AgentService";
export * from "./EventService";
export * from "./flags";
export * from "./GitHub";
export * from "./S3";
export * from "./Tools";
export * as MCP from "./Mcp";
export * from "./EmbeddingService";
export { Clients } from "../clients";
export { Plugins };

let Singletons = {} as {
  Tools: ToolsService;
  Events: EventService;
  Agents: AgentService;
  Flags: FlagsService;
  GitHub: GitHubService;
  Mcp: McpService;
  AwsS3: S3Service;
  knowhowApiClient: KnowhowSimpleClient;
  Plugins: typeof Plugins;
  Clients: typeof Clients;
};

export const services = (): typeof Singletons => {
  if (Object.keys(Singletons).length === 0) {
    const Tools = new ToolsService();
    const Events = new EventService();
    const Agents = new AgentService(Tools, Events);
    Singletons = {
      Tools,
      Events,
      Agents,

      Flags: new FlagsService(),
      GitHub: new GitHubService(),
      Mcp: new McpService(),
      AwsS3: new S3Service(),
      knowhowApiClient: new KnowhowSimpleClient(process.env.KNOWHOW_API_URL),
      Plugins,
      Clients,
    };

    Singletons.Tools.setContext({
      agentService: Singletons.Agents,
      eventService: Singletons.Events,
      pluginService: Plugins,
      clients: Clients,
    });
  }

  return Singletons;
};
