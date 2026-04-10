import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { DownloaderPlugin } from "./plugin";
import { DownloaderService } from "./downloader";

const plugins: ModulePlugin[] = [
  { name: "download", plugin: DownloaderPlugin }
];

const module: KnowhowModule = {
  async init() {},
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { DownloaderPlugin, DownloaderService };
