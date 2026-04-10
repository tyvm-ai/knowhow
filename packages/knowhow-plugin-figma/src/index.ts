import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { FigmaPlugin } from "./figma";

const plugins: ModulePlugin[] = [{ name: "figma", plugin: FigmaPlugin }];

const module: KnowhowModule = {
  async init() {},
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { FigmaPlugin };
