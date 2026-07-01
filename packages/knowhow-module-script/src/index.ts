import * as fs from "fs";
import * as path from "path";
import {
  KnowhowModule,
  InitParams,
} from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { executeScript } from "./handler";
import { executeScriptDefinition } from "./definition";
import { ScriptExecutor } from "./ScriptExecutor";

export { ScriptExecutor } from "./ScriptExecutor";
export { SandboxContext } from "./SandboxContext";
export { ScriptPolicyEnforcer } from "./ScriptPolicy";
export { ScriptTracer } from "./ScriptTracer";
export * from "./types";

const scriptModule: KnowhowModule = {
  async init(params: InitParams) {
    const program = params.context?.Program;
    if (!program) return;

    // Register `knowhow script` CLI command
    program
      .command("script")
      .description(
        "Run a local tool script file using the executeScript sandbox"
      )
      .option(
        "--input-file <path>",
        "Path to a local .js/.ts script file to run"
      )
      .option(
        "--allow-network",
        "Allow fetch() calls in the script (disabled by default for security)"
      )
      .action(async (options) => {
        try {
          if (!options.inputFile) {
            console.error(
              "Error: Provide --input-file <path> to the script file to run"
            );
            process.exit(1);
          }

          const scriptPath = path.resolve(options.inputFile);
          if (!fs.existsSync(scriptPath)) {
            console.error(`Error: Script file not found: ${scriptPath}`);
            process.exit(1);
          }
          const scriptContent = fs.readFileSync(scriptPath, "utf-8");

          // Lazy-load services so we only spin them up when the command is actually run
          const { LazyToolsService, services } = await import(
            "@tyvm/knowhow/ts_build/src/services"
          );
          const { ModulesService } = await import(
            "@tyvm/knowhow/ts_build/src/services/modules"
          );

          const { Clients, Tools: AllTools, Mcp } = services();

          const Tools = new LazyToolsService();
          Tools.setContext({ ...AllTools.getContext() });

          // Register all agent tools (including MCP management tools like
          // listAvailableMcpServers, connectMcpServer, disconnectMcpServer)
          const { includedTools } = await import(
            "@tyvm/knowhow/ts_build/src/agents/tools/list"
          );
          const allTools = await import(
            "@tyvm/knowhow/ts_build/src/agents/tools"
          );
          Tools.defineTools(includedTools, allTools);

          Tools.addContext("Mcp", Mcp);

          console.log("🔌 Connecting to MCP...");
          try {
            await Mcp.connectToConfigured(Tools);
          } catch (mcpError) {
            const msg =
              mcpError instanceof Error ? mcpError.message : String(mcpError);
            console.warn(
              `⚠ Some MCP servers failed to connect (continuing): ${msg}`
            );
          }

          console.log("Connecting to clients...");
          await Clients.registerConfiguredModels();

          // Load modules (tools, plugins, etc.) from config
          const modulesService = new ModulesService();
          const modulesContext = await modulesService.overrideDefaultContext({
            Tools,
            Clients,
          });
          await modulesService.loadModulesFromConfig(modulesContext);

          // Enable all tools so scripts can access MCP tools
          Tools.enableTools(["*"]);

          const executor = new ScriptExecutor(Tools, Clients);
          const result = await executor.execute({
            script: scriptContent,
            policy: {
              allowNetworkAccess: !!options.allowNetwork,
            },
            quotas: {
              maxExecutionTimeMs: 5 * 60 * 1000, // 5 minutes for CLI scripts
            },
          });

          if (result.consoleOutput?.length) {
            console.log(result.consoleOutput.join("\n"));
          }
          console.log(JSON.stringify(result.result, null, 2));
          if (!result.success) {
            console.error("Script error:", result.error);
            process.exit(1);
          }
        } catch (error) {
          console.error("Error running script:", error);
          process.exit(1);
        }
      });
  },

  tools: [
    {
      name: "executeScript",
      handler: executeScript,
      definition: executeScriptDefinition,
    },
  ],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default scriptModule;
