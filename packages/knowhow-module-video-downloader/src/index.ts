import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { DownloaderPlugin } from "./plugin";
import { DownloaderService } from "./downloader";
import { VideoUrlResolver } from "./resolver";

const plugins: ModulePlugin[] = [
  { name: "download", plugin: DownloaderPlugin }
];

const videoDownloaderModule: KnowhowModule = {
  async init({ context }) {
    context?.Conversion?.registerResolver(new VideoUrlResolver());
  },
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default videoDownloaderModule;
export { DownloaderPlugin, DownloaderService, VideoUrlResolver };
