import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { NotionPlugin } from "./notion";

const plugins: ModulePlugin[] = [{ name: "notion", plugin: NotionPlugin }];

const module: KnowhowModule = {
  async init() {},
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { NotionPlugin };
