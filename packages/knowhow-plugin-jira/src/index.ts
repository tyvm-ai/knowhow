import { KnowhowModule, ModulePlugin } from "@tyvm/knowhow";
import { JiraPlugin } from "./jira";

const plugins: ModulePlugin[] = [{ name: "jira", plugin: JiraPlugin }];

const module: KnowhowModule = {
  async init() {},
  tools: [],
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { JiraPlugin };
