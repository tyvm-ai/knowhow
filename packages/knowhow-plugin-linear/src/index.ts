import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { LinearPlugin } from "./linear";

const plugins: ModulePlugin[] = [{ name: "linear", plugin: LinearPlugin }];

const module: KnowhowModule = {
  async init() {},
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { LinearPlugin };
