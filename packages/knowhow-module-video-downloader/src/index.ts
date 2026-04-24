import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { DownloaderPlugin } from "./plugin";
import { DownloaderService } from "./downloader";

const plugins: ModulePlugin[] = [
  { name: "download", plugin: DownloaderPlugin }
];

const videoDownloaderModule: KnowhowModule = {
  async init() {},
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default videoDownloaderModule;
export { DownloaderPlugin, DownloaderService };
