import { KnowhowModule, ModulePlugin, ModuleTool } from "@tyvm/knowhow";
import { AsanaPlugin } from "./asana";
import { definitions } from "./tools/asana/definitions";
import * as asanaHandlers from "./tools/asana/index";

const tools: ModuleTool[] = definitions.map((def) => ({
  name: def.function.name,
  handler: asanaHandlers[def.function.name],
  definition: def as any,
}));

const plugins: ModulePlugin[] = [
  { name: "asana", plugin: AsanaPlugin }
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
export { AsanaPlugin };
