import { KnowhowModule, ModulePlugin, ModuleTool } from "@tyvm/knowhow";
import { GitHubPlugin } from "./github";
import { definitions } from "./tools/github/definitions";
import * as githubHandlers from "./tools/github/index";

const tools: ModuleTool[] = definitions.map((def) => ({
  name: def.function.name,
  handler: githubHandlers[def.function.name],
  definition: def as any,
}));

const plugins: ModulePlugin[] = [
  { name: "github", plugin: GitHubPlugin }
];

const module: KnowhowModule = {
  async init() {},
  tools,
  agents: [],
  plugins,
  clients: [],
  commands: [],
};

export default module;
export { GitHubPlugin };
