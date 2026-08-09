import * as fs from "fs";
import * as path from "path";
import {
  KnowhowModule,
  InitParams,
} from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { persistArtifacts, printManifestSummary } from "./artifactPersistence";
import { executeScript } from "./handler";
import { executeScriptDefinition } from "./definition";
import { ScriptExecutor } from "./ScriptExecutor";
import { checkScript, formatDiagnostics } from "./checkScript";
import { generateScriptTypeDefs } from "./typeDefs";
import {
  startScript,
  startScriptFile,
  listScripts,
  getScriptRun,
  getScriptEvents,
  waitForScriptEvents,
  sendScriptMessage,
  waitForScript,
  cancelScript,
} from "./asyncHandlers";
import {
  startScriptDefinition,
  startScriptFileDefinition,
  listScriptsDefinition,
  getScriptRunDefinition,
  getScriptEventsDefinition,
  waitForScriptEventsDefinition,
  sendScriptMessageDefinition,
  waitForScriptDefinition,
  cancelScriptDefinition,
} from "./asyncDefinitions";
import { workflowCommand } from "./workflow";

export { ScriptExecutor } from "./ScriptExecutor";
export { SandboxContext } from "./SandboxContext";
export { ScriptPolicyEnforcer } from "./ScriptPolicy";
export { ScriptTracer } from "./ScriptTracer";
export { checkScript, formatDiagnostics } from "./checkScript";
export { generateScriptTypeDefs } from "./typeDefs";
export * from "./types";
export * from "./ScriptRunService";
export * from "./asyncHandlers";
export * from "./asyncDefinitions";
export * from "./artifactPersistence";
export * from "./asciiWorkflow";
export * from "./workflow";

const scriptModule: KnowhowModule = {
  extensions: [{
    type: "chat",
    commands: [{
      name: "workflow",
      description: "Show an async script workflow (graph by default): /workflow [graph|list] [runId]",
      handler: async (args, chatService) => workflowCommand(args, chatService),
    }],
  }],
  async init(params: InitParams) {
    const program = params.context?.Program;
    if (!program) return;

    // ── Sample script shown by --sample ──────────────────────────────────────
    const SAMPLE_SCRIPT = `// KnowHow Script — sample program
// All tools registered in your session are available as globals.
// Use callTool("toolName", args) or the shorthand: readFile({ filePath: "..." })

// 1. Read a file
const content = await readFile({ filePath: "README.md" });
console.log("File length:", typeof content === "string" ? content.length : JSON.stringify(content).length);

// 2. Call an LLM (model is required)
const reply = await llm(
  [{ role: "user", content: "Say hello in one sentence." }],
  { model: "claude-sonnet-4-5" }
);
console.log("LLM reply:", reply);

// 3. Emit progress events (visible to the outer agent via getScriptEvents)
emit("progress", { step: "done", message: "Script finished" });

// 4. Return a value — the last expression is the script result
({ ok: true, contentLength: typeof content === "string" ? content.length : 0 })
`;

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
        "--args <json>",
        "JSON object exposed to the script as the read-only scriptArgs global"
      )
       .option(
         "--check",
         "Type-check the script against the available tools and exit (do not run)"
       )
       .option(
         "--emit-types <path>",
         "Write the generated TypeScript declarations (.d.ts) for the sandbox globals to a file and exit"
       )
      .option(
        "--list-tools",
        "Print all tool names available inside the script sandbox and exit"
      )
      .option(
        "--sample",
        "Print a sample script demonstrating common patterns and exit"
      )
      .option(
        "--artifact-dir <path>",
        "Directory to persist script artifacts. Each run creates a timestamped subdirectory containing artifact files and a manifest.json."
      )
      .action(async (options) => {
        try {
          // --sample: print a starter program and exit (no setup needed)
          if (options.sample) {
            process.stdout.write(SAMPLE_SCRIPT);
            return process.exit(0);
          }

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

          const toolDefs =
            typeof (Tools as any).getTools === "function"
              ? (Tools as any).getTools()
              : [];

          // --list-tools: print all available tool names and exit
          if (options.listTools) {
            const names: string[] = toolDefs
              .map((t: any) => t?.function?.name)
              .filter(Boolean)
              .sort();
            console.log(`Available tools in script sandbox (${names.length} total):\n`);
            for (const name of names) {
              const def = toolDefs.find((t: any) => t?.function?.name === name);
              const desc = def?.function?.description?.split("\n")[0] ?? "";
              console.log(`  ${name.padEnd(35)} ${desc}`);
            }
            console.log("\nBuilt-in globals: scriptArgs, callTool, llm, agent, sleep, emit, waitForMessage, onMessage, isCancelled, untilCancelled, createArtifact, getQuotaUsage, console");
            return process.exit(0);
          }

          // --emit-types: write the .d.ts and exit.
          if (options.emitTypes) {
            const defs = generateScriptTypeDefs(toolDefs);
            const outPath = path.resolve(options.emitTypes);
            fs.writeFileSync(outPath, defs, "utf-8");
            console.log(`Wrote sandbox type declarations to ${outPath}`);
            return process.exit(0);
          }

          if (!options.inputFile) {
            console.error(
              "Error: Provide --input-file <path> to the script file to run"
            );
            return process.exit(1);
          }

          const scriptPath = path.resolve(options.inputFile);
          if (!fs.existsSync(scriptPath)) {
            console.error(`Error: Script file not found: ${scriptPath}`);
            return process.exit(1);
          }
          const scriptContent = fs.readFileSync(scriptPath, "utf-8");

          let scriptArgs: Record<string, unknown> = {};
          if (options.args !== undefined) {
            try {
              const parsed = JSON.parse(options.args);
              if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
                throw new Error("value must be a JSON object");
              }
              scriptArgs = parsed;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Error: Invalid --args JSON: ${message}`);
              return process.exit(1);
            }
          }

           // Always run a fast compile check first (fail fast on obvious errors).
           const checkResult = checkScript(scriptContent, toolDefs);
           if (options.check || !checkResult.ok) {
             console.log(formatDiagnostics(checkResult));
           }
           if (options.check) {
             return process.exit(checkResult.ok ? 0 : 1);
           }
           if (!checkResult.ok) {
             console.error("\nAborting run due to type-check errors above. Use --check to see details, or fix and retry.");
             return process.exit(1);
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
            args: scriptArgs,
            policy: {
              allowNetworkAccess: !!options.allowNetwork,
            },
            onEvent: renderEvent,
          });

          // Only print the final return value — live output was already
          // streamed above via onEvent.
          console.log(JSON.stringify(result.result, null, 2));

          // Persist artifacts to disk if --artifact-dir was provided.
          // This is done AFTER printing the result so that artifact paths
          // appear below the script output in a clear block.
          if (options.artifactDir && result.artifacts.length > 0) {
            const manifest = persistArtifacts(result.artifacts, options.artifactDir);
            printManifestSummary(manifest);
          } else if (options.artifactDir && result.artifacts.length === 0) {
            process.stdout.write("[artifacts] No artifacts produced by this run.\n");
          }

          if (!result.success) {
            console.error("Script error:", result.error);
            return process.exit(1);
          }
        } catch (error) {
          console.error("Error running script:", error);
          return process.exit(1);
        }
      });
  },

  tools: [
    {
      name: "executeScript",
      handler: executeScript,
      definition: executeScriptDefinition,
    },
    {
      name: "startScript",
      handler: startScript,
      definition: startScriptDefinition,
    },
    {
      name: "startScriptFile",
      handler: startScriptFile,
      definition: startScriptFileDefinition,
    },
    {
      name: "listScripts",
      handler: listScripts,
      definition: listScriptsDefinition,
    },
    {
      name: "getScriptRun",
      handler: getScriptRun,
      definition: getScriptRunDefinition,
    },
    {
      name: "getScriptEvents",
      handler: getScriptEvents,
      definition: getScriptEventsDefinition,
    },
    {
      name: "waitForScriptEvents",
      handler: waitForScriptEvents,
      definition: waitForScriptEventsDefinition,
    },
    {
      name: "sendScriptMessage",
      handler: sendScriptMessage,
      definition: sendScriptMessageDefinition,
    },
    {
      name: "waitForScript",
      handler: waitForScript,
      definition: waitForScriptDefinition,
    },
    {
      name: "cancelScript",
      handler: cancelScript,
      definition: cancelScriptDefinition,
    },
  ],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default scriptModule;
