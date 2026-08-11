import { InitParams, KnowhowModule } from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { WorldlineRegistry } from "./worldlines";

export * from "./worldlines";

/** Shared registry for direct library consumers. */
export const worldlines = new WorldlineRegistry();

/**
 * Knowhow module adapter. It exposes the generic registry on ModuleContext as
 * `Worldlines`; domain modules may use it without depending on computer-use.
 */
const worldlinesModule: KnowhowModule = {
  async register(params: InitParams) {
    const context = params.context as any;
    if (context && !context.Worldlines) context.Worldlines = worldlines;
    const tools = context?.Tools;
    if (tools) {
      const current = tools.getContext() ?? {};
      if (!current.Worldlines) tools.setContext({ ...current, Worldlines: worldlines });
    }
  },
  async init(_params: InitParams) {},
  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default worldlinesModule;
