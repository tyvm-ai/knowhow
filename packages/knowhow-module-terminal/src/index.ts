import { KnowhowModule, InitParams } from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { TunnelTerminalAddon } from "./TunnelTerminalAddon";

export { TunnelTerminalAddon } from "./TunnelTerminalAddon";

const terminalModule: KnowhowModule = {
  async init(params: InitParams) {
    const tunnelHandler = params.context?.Tunnel;
    if (tunnelHandler) {
      tunnelHandler.use(new TunnelTerminalAddon());
      console.log("✅ Terminal module: TunnelTerminalAddon registered on tunnel handler");
    } else {
      console.warn("⚠️  Terminal module: no TunnelHandler in context — terminal addon not registered");
    }
  },
  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default terminalModule;
