import * as fs from "fs";
import * as path from "path";
import {
  KnowhowModule,
  InitParams,
} from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { executeScript } from "./handler";
import { executeScriptDefinition } from "./definition";
import { ScriptExecutor } from "./ScriptExecutor";
import { checkScript, formatDiagnostics } from "./checkScript";
import { generateScriptTypeDefs } from "./typeDefs";

export { ScriptExecutor } from "./ScriptExecutor";
export { SandboxContext } from "./SandboxContext";
export { ScriptPolicyEnforcer } from "./ScriptPolicy";
export { ScriptTracer } from "./ScriptTracer";
export { checkScript, formatDiagnostics } from "./checkScript";
export { generateScriptTypeDefs } from "./typeDefs";
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
       .option(
         "--check",
         "Type-check the script against the available tools and exit (do not run)"
       )
       .option(
         "--emit-types <path>",
         "Write the generated TypeScript declarations (.d.ts) for the sandbox globals to a file and exit"
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

          // Lazy-load the shared CLI service setup so the script command gets
          // the EXACT same wiring as `knowhow agent`/`knowhow chat`: MCP,
          // models, modules, AND registered agents (so tools like agentCall /
          // startAgentTask work inside scripts). Previously this command
          // duplicated setup and never registered agents.
          const { setupServices } = await import(
            "@tyvm/knowhow/ts_build/src/commands/services"
          );
          const { Tools, Clients } = await setupServices();

          // Enable all tools so scripts can access MCP tools
          Tools.enableTools(["*"]);

           // Collect the available tool definitions for typing/checking.
           const toolDefs =
             typeof (Tools as any).getTools === "function"
               ? (Tools as any).getTools()
               : [];
 
           // --emit-types: write the .d.ts and exit.
           if (options.emitTypes) {
             const defs = generateScriptTypeDefs(toolDefs);
             const outPath = path.resolve(options.emitTypes);
             fs.writeFileSync(outPath, defs, "utf-8");
             console.log(`Wrote sandbox type declarations to ${outPath}`);
             process.exit(0);
           }
 
           // Always run a fast compile check first (fail fast on obvious errors).
           const checkResult = checkScript(scriptContent, toolDefs);
           if (options.check || !checkResult.ok) {
             console.log(formatDiagnostics(checkResult));
           }
           if (options.check) {
             process.exit(checkResult.ok ? 0 : 1);
           }
           if (!checkResult.ok) {
             console.error("\nAborting run due to type-check errors above. Use --check to see details, or fix and retry.");
             process.exit(1);
           }
 
          const executor = new ScriptExecutor(Tools, Clients);

          // Render trace events live as the script runs so that console.log
          // output (and other interesting events like tool calls) appear
          // immediately rather than being buffered until the script finishes.
          const renderEvent = (event: { type: string; data: any }) => {
            switch (event.type) {
              case "console_log":
                process.stdout.write(`[script] ${event.data.message}\n`);
                break;
              case "console_info":
                process.stdout.write(`[script:info] ${event.data.message}\n`);
                break;
              case "console_warn":
                process.stderr.write(`[script:warn] ${event.data.message}\n`);
                break;
              case "console_error":
                process.stderr.write(`[script:error] ${event.data.message}\n`);
                break;
              case "tool_call_start":
                process.stderr.write(`[script:tool] → ${event.data.toolName}\n`);
                break;
              case "tool_call_success":
                process.stderr.write(`[script:tool] ✓ ${event.data.toolName}\n`);
                break;
              case "tool_call_error":
                process.stderr.write(
                  `[script:tool] ✗ ${event.data.toolName}: ${event.data.error}\n`
                );
                break;
              // Other events (llm calls, agent calls, etc.) are silently
              // recorded in the trace but not printed to avoid noise. Add
              // cases here to expose more detail.
            }
          };

          const result = await executor.execute({
            script: scriptContent,
            policy: {
              allowNetworkAccess: !!options.allowNetwork,
            },
            quotas: {
               maxExecutionTimeMs: 30 * 60 * 1000, // 30 minutes for CLI scripts
            },
            onEvent: renderEvent,
          });

          // Only print the final return value — live output was already
          // streamed above via onEvent.
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
