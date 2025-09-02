import { DownloaderService } from "../plugins/downloader/downloader";
import { AIClient, Clients } from "../clients";
import { AgentService } from "./AgentService";
import { EventService } from "./EventService";
import { FlagsService } from "./flags";
import { GitHubService } from "./GitHub";
import { KnowhowSimpleClient } from "./KnowhowClient";
import { McpService } from "./Mcp";
import { S3Service } from "./S3";
import { ToolsService } from "./Tools";
import { PluginService } from "../plugins/plugins";

export * from "./AgentService";
export * from "./EventService";
export * from "./flags";
export * from "./GitHub";
export * from "./S3";
export * from "./Tools";
export * as MCP from "./Mcp";
export * from "./EmbeddingService";
export { Clients } from "../clients";

let Singletons = {} as {
  Tools: ToolsService;
  Events: EventService;
  Agents: AgentService;
  Flags: FlagsService;
  GitHub: GitHubService;
  Mcp: McpService;
  AwsS3: S3Service;
  knowhowApiClient: KnowhowSimpleClient;
  Plugins: PluginService;
  Clients: AIClient;
  Downloader: DownloaderService;
};

export const services = (): typeof Singletons => {
  if (Object.keys(Singletons).length === 0) {
    const Tools = new ToolsService();
    const Events = new EventService();
    const Agents = new AgentService(Tools, Events);
    const Downloader = new DownloaderService(Clients);
    const Plugins = new PluginService({
      Agents,
      Events,
      Tools,
      Clients,
    });

    Singletons = {
      Agents,
      AwsS3: new S3Service(),
      Clients,
      Downloader,
      Events,
      Flags: new FlagsService(),
      GitHub: new GitHubService(),
      Mcp: new McpService(),
      Plugins,
      Tools,
      knowhowApiClient: new KnowhowSimpleClient(process.env.KNOWHOW_API_URL),
    };

    Singletons.Tools.setContext({
      Agents,
      Events,
      Plugins,
      Clients,
    });
  }

  return Singletons;
};
