import { KnowhowModule, InitParams } from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { TunnelTerminalAddon } from "./TunnelTerminalAddon";

export { TunnelTerminalAddon } from "./TunnelTerminalAddon";

const terminalModule: KnowhowModule = {
  async init(params: InitParams) {
    const tunnelHandler = params.context?.Tunnel;
    if (tunnelHandler) {
      tunnelHandler.use(new TunnelTerminalAddon());
      console.log("✅ Terminal module: TunnelTerminalAddon registered on tunnel handler");
    }

    // Register `knowhow terminal` CLI command when Program is available
    const program = params.context?.Program;
    if (program) {
      program
        .command("terminal")
        .description("Attach your local terminal to a remote knowhow worker's PTY")
        .option("-i, --interactive", "Interactively pick a worker from a numbered list")
        .option("-a, --attach <name>", "Attach to a worker by name/path/email substring match")
        .option("--id <workerId>", "Attach to a worker by exact ID")
        .option("--command <cmd>", "Shell command to run on the remote worker (default: bash)", "bash")
        .action(async (options) => {
          const { attachTerminal } = await import("./terminalAttach");
          await attachTerminal(options);
        });
    }
  },
  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default terminalModule;
