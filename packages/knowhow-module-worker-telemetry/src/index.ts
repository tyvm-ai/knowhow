import type { InitParams, KnowhowModule } from "./telemetryTransport";
import { TunnelTelemetryAddon } from "./TunnelTelemetryAddon";

let addonInstance: TunnelTelemetryAddon | null = null;

const telemetryModule: KnowhowModule = {
  async init(params: InitParams) {
    const tunnelHandler = params.context?.Tunnel;
    if (tunnelHandler) {
      addonInstance = new TunnelTelemetryAddon(params.config);
      tunnelHandler.use(addonInstance);
    }
  },

  async destroy() {
    if (addonInstance) {
      await addonInstance.destroy();
      addonInstance = null;
    }
  },

  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default telemetryModule;
export * from "./types";
export { TunnelTelemetryAddon } from "./TunnelTelemetryAddon";
