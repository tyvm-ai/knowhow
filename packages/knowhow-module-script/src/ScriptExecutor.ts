// `isolated-vm` is a native (node-gyp) addon. We import ONLY its types eagerly
// (a compile-time-only construct that emits no runtime `require`), and defer the
// actual runtime load until a script is executed. This keeps merely *loading*
// this module (during knowhow module init) from touching the native binary — so
// a broken/mismatched isolated-vm build fails when you run a script, not when
// knowhow starts up.
import type ivm from "isolated-vm";

/**
 * Cached, lazily-loaded runtime handle to the isolated-vm native module.
 *
 * We `require` it on first use rather than importing at module top-level so that
 * a failing native load surfaces as a catchable error at script-execution time
 * (see loadIsolatedVm) instead of aborting the whole process at import time.
 */
let _ivmRuntime: typeof ivm | null = null;
function getIvm(): typeof ivm {
  if (!_ivmRuntime) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _ivmRuntime = require("isolated-vm");
    } catch (err) {
      throw new Error(formatIsolatedVmLoadError(err));
    }
  }
  return _ivmRuntime as typeof ivm;
}

/**
 * `isolated-vm` is a native (node-gyp) addon. It can fail to load for a few
 * distinct reasons, and the raw errors are cryptic. Two common ones:
 *
 *   1. "Cannot find module 'isolated-vm'" — the package isn't installed at all.
 *   2. "No native build was found for platform=... abi=..." — the JS package is
 *      installed, but the matching native `.node` binary is missing. This is the
 *      classic symptom of npm 11 (and restrictive org/CI policies) *blocking the
 *      install/build script by default*. isolated-vm's `install` script
 *      (`node-gyp-build || node-gyp rebuild`) never ran, so no prebuild was
 *      selected and nothing was compiled — leaving the binary absent.
 *
 * In both cases the fix is the same for a knowhow user: reinstall the module
 * while allowing install scripts to run. We surface that as an actionable
 * message so users don't have to reverse-engineer the node-gyp error.
 */
function formatIsolatedVmLoadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const isMissingModule =
    /cannot find module ['"]isolated-vm['"]/i.test(raw) ||
    (err as any)?.code === "MODULE_NOT_FOUND";
  const isMissingNativeBuild = /no native build was found/i.test(raw);

  const reason = isMissingModule
    ? "The 'isolated-vm' package is not installed."
    : isMissingNativeBuild
    ? "The 'isolated-vm' package is installed, but its native binary was not built.\n" +
      "This almost always means the install/build script was blocked (npm 11+ blocks\n" +
      "package install scripts by default), so no prebuilt binary was selected and\n" +
      "nothing was compiled."
    : "Failed to load the 'isolated-vm' native module.";

  return [
    "Cannot run scripts: the isolated-vm sandbox failed to load.",
    "",
    reason,
    "",
    "To fix this, reinstall the script module while allowing native install scripts:",
    "",
    "  # Global install (~/.knowhow):",
    "  knowhow modules install @tyvm/knowhow-module-script --global --allow-scripts",
    "",
    "  # Local install (./.knowhow):",
    "  knowhow modules install @tyvm/knowhow-module-script --allow-scripts",
    "",
    "  # Or, if you set up with `knowhow modules setup`, re-run it with:",
    "  knowhow modules setup --allow-scripts",
    "",
    "The --allow-scripts flag lets isolated-vm run its node-gyp build step so the",
    "correct native binary is installed for your Node.js version.",
    "",
    `(original error: ${raw})`,
  ].join("\n");
}

import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";
import { AIClient } from "@tyvm/knowhow/ts_build/src/clients";
import { SandboxContext } from "./SandboxContext";
import { ScriptTracer } from "./ScriptTracer";
import { ScriptPolicyEnforcer } from "./ScriptPolicy";
import {
  ExecutionRequest,
  ExecutionResult,
  ResourceQuotas,
  SecurityPolicy,
} from "./types";

/**
 * Executes TypeScript scripts in a secure sandbox environment
 */
export class ScriptExecutor {
  private defaultQuotas: ResourceQuotas = {
    maxToolCalls: 50,
    maxTokens: 10000,
    maxExecutionTimeMs: 30000, // 30 seconds
    maxCostUsd: 1.0,
    maxMemoryMb: 100,
  };

  private defaultPolicy: SecurityPolicy = {
    allowlistedTools: [], // Empty means all tools allowed
    denylistedTools: [
      "executeScript", // Circular script execution
      "execCommand", // Dangerous system commands
      "writeFileChunk", // File system write access
      "patchFile", // File system modification
    ],
    maxScriptLength: 50000, // 50KB
    allowNetworkAccess: false,
    allowFileSystemAccess: false,
  };

  constructor(private toolsService: ToolsService, private clients: AIClient) {
    this.validateNodejsEnvironment();
  }

  /**
   * Validate that Node.js environment is properly configured for isolated-vm
   */
  private validateNodejsEnvironment(): void {
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split(".")[0], 10);

    if (majorVersion >= 20) {
      const hasNoNodeSnapshot = process.execArgv.includes("--no-node-snapshot");

      if (!hasNoNodeSnapshot) {
        const errorMessage = [
          `Node.js ${nodeVersion} detected. The executeScript tool requires the --no-node-snapshot flag for isolated-vm compatibility.`,
          "",
          "This flag is automatically included when running knowhow commands via the CLI (e.g., `knowhow agent`, `knowhow chat`).",
          "",
          "If you are programmatically using knowhow or running custom scripts:",
          "1. Start your application with: node --no-node-snapshot your-app.js",
          '2. Or update your package.json scripts to include the flag:',
          '   "scripts": {',
          '     "start": "node --no-node-snapshot dist/index.js"',
          "   }",
          "",
          "Note: This flag is required for Node.js 20+ to ensure isolated-vm works correctly.",
        ].join("\n");

        throw new Error(errorMessage);
      }
    }
  }

  /**
   * Execute a TypeScript script in sandbox
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const tracer = new ScriptTracer();

    // Wire up the caller's real-time event listener BEFORE the first event is
    // emitted so that execution_start (and everything after) is streamed out.
    let unsubscribe: (() => void) | undefined;
    if (request.onEvent) {
      unsubscribe = tracer.onEvent(request.onEvent);
    }

    const quotas = { ...this.defaultQuotas, ...request.quotas };
    const policy = { ...this.defaultPolicy, ...request.policy };
    const policyEnforcer = new ScriptPolicyEnforcer(quotas, policy);

    tracer.emitEvent("execution_start", {
      scriptLength: request.script.length,
      quotas,
      policy: {
        ...policy,
        allowlistedTools: `${policy.allowlistedTools.length} tools`,
        denylistedTools: `${policy.denylistedTools.length} tools`,
      },
    });

    try {
      // Validate script
      const validation = policyEnforcer.validateScript(
        request.script,
        policy.allowNetworkAccess
      );
      if (!validation.valid) {
        tracer.emitEvent("script_validation_failed", {
          issues: validation.issues,
        });

        return {
          success: false,
          error: `Script validation failed: ${validation.issues.join(", ")}`,
          result: null,
          trace: tracer.getTrace(),
          artifacts: [],
          consoleOutput: [],
        };
      }

      tracer.emitEvent("script_validation_passed", {});

      // Create sandbox context
      const context = new SandboxContext(
        this.toolsService,
        this.clients,
        tracer,
        policyEnforcer
      );

      // Execute script with timeout
      const timeoutMs = quotas.maxExecutionTimeMs;

      const result = await this.executeWithTimeout(
        request.script,
        context,
        timeoutMs,
        tracer,
        policyEnforcer
      );

      tracer.emitEvent("execution_complete", {
        finalUsage: policyEnforcer.getUsage(),
      });

      return {
        success: true,
        error: null,
        result,
        trace: tracer.getTrace(),
        artifacts: context.getArtifacts(),
        consoleOutput: context.getConsoleOutput(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      tracer.emitEvent("execution_error", {
        error: errorMessage,
        finalUsage: policyEnforcer.getUsage(),
      });

      return {
        success: false,
        error: errorMessage,
        result: null,
        trace: tracer.getTrace(),
        artifacts: [],
        consoleOutput: [],
      };
    } finally {
      // Always clean up the event listener subscription.
      unsubscribe?.();
    }
  }

  /**
   * Execute script with timeout protection
   */
  private async executeWithTimeout(
    script: string,
    context: SandboxContext,
    timeoutMs: number,
    tracer: ScriptTracer,
    policyEnforcer: ScriptPolicyEnforcer
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        tracer.emitEvent("execution_timeout", { timeoutMs });
        reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.executeScriptSecure(script, context, tracer, policyEnforcer)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Secure script execution using isolated-vm
   */
  private async executeScriptSecure(
    script: string,
    context: SandboxContext,
    tracer: ScriptTracer,
    policyEnforcer: ScriptPolicyEnforcer
  ) {
    tracer.emitEvent("secure_execution_start", {
      note: "Using isolated-vm for secure execution",
    });

    const ivm = getIvm();
    const isolate = new ivm.Isolate({
      memoryLimit: policyEnforcer.getQuotas().maxMemoryMb,
    });

    try {
      const vmContext = await isolate.createContext();

      tracer.emitEvent("vm_context_created", {});

      await this.setupIsolatedContext(vmContext, context, tracer);

      tracer.emitEvent("script_compilation_start", {});

      const scriptWithReturn = this.injectReturnForLastExpression(script);

      const wrappedScript = `
        (async function() {
          "use strict";
          ${scriptWithReturn}
        })()
      `;

      const compiledScript = await isolate.compileScript(wrappedScript);

      tracer.emitEvent("script_compilation_complete", {});
      tracer.emitEvent("script_execution_start", {});

      const result = await compiledScript.run(vmContext, {
        promise: true,
        copy: true,
      });

      tracer.emitEvent("script_execution_complete", {
        resultType: typeof result,
      });

      return result;
    } finally {
      isolate.dispose();
      tracer.emitEvent("vm_cleanup_complete", {});
    }
  }

  /**
   * Set up the isolated context with safe globals and sandbox functions
   */
  private async setupIsolatedContext(
    vmContext: ivm.Context,
    sandboxContext: SandboxContext,
    tracer: ScriptTracer
  ): Promise<void> {
    tracer.emitEvent("context_setup_start", {});

    const ivm = getIvm();
    const globalRef = vmContext.global;
    await globalRef.set("globalThis", globalRef.derefInto());

    const exposeAsync = async (
      name: string,
      fn: (...a: any[]) => Promise<any>
    ) => {
      await globalRef.set(
        `__host_${name}`,
        new ivm.Reference(async (...args: any[]) => {
          const result = await fn(...args);
          const safeResult = result !== undefined ? result : null;
          const plainResult =
            safeResult !== null && typeof safeResult === "object"
              ? JSON.parse(JSON.stringify(safeResult))
              : safeResult;
          return new ivm.ExternalCopy(plainResult).copyInto();
        })
      );
      await vmContext.eval(`
        globalThis.${name} = (...a) =>
          new Promise((resolve, reject) => {
            try {
              const result = __host_${name}.applySyncPromise(undefined, a,
                { arguments: { copy: true } });
              resolve(result);
            } catch(e) { reject(e); }
          });
      `);
    };

    const exposeSync = async (name: string, fn: (...a: any[]) => any) => {
      await globalRef.set(
        `__host_${name}`,
        new ivm.Reference((...args: any[]) => {
          const result = fn(...args);
          return new ivm.ExternalCopy(result).copyInto();
        })
      );
      await vmContext.eval(`
        globalThis.${name} = (...a) =>
          __host_${name}.apply(undefined, a,
            { arguments: { copy: true }, result: { copy: true } });
      `);
    };

    await exposeAsync("callTool", async (tool, params) => {
      try {
        const result = await sandboxContext.callTool(tool as string, params);
        const { functionResp } = result;
        return functionResp !== undefined ? functionResp : null;
      } catch (err) {
        throw err;
      }
    });
    await exposeAsync("llm", (messages, options) =>
      sandboxContext.llm(messages, options || {})
    );
    await exposeAsync("agent", (agentName, query) =>
      sandboxContext.agent(agentName as string, query as string)
    );
    await exposeAsync("sleep", (ms) => sandboxContext.sleep(ms));

    await exposeSync("createArtifact", (name, content, type) =>
      sandboxContext.createArtifact(name as string, content, type)
    );
    await exposeSync("getQuotaUsage", () => sandboxContext.getQuotaUsage());

    // Generic function resolver: for every available tool that isn't already a
    // reserved global, expose a top-level function of the same name that routes
    // to callTool(<name>, params). This lets scripts write `textSearch({...})`
    // instead of `callTool('textSearch', {...})`. Reserved globals (callTool,
    // llm, agent, sleep, console, etc.) are never shadowed.
    const reserved = new Set([
      "callTool",
      "llm",
      "agent",
      "sleep",
      "createArtifact",
      "getQuotaUsage",
      "console",
      "globalThis",
      "executeScript",
    ]);
    let toolNames: string[] = [];
    try {
      toolNames = sandboxContext
        .listToolNames()
        .filter(
          (n) =>
            typeof n === "string" &&
            /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) &&
            !reserved.has(n)
        );
    } catch {
      toolNames = [];
    }
    if (toolNames.length) {
      await globalRef.set(
        "__tool_names",
        new ivm.ExternalCopy(toolNames).copyInto()
      );
      await vmContext.eval(`
        for (const __name of globalThis.__tool_names) {
          if (typeof globalThis[__name] === "undefined") {
            globalThis[__name] = ((__n) => (params) => callTool(__n, params || {}))(__name);
          }
        }
      `);
      tracer.emitEvent("tool_globals_registered", { count: toolNames.length });
    }

    for (const level of ["log", "info", "warn", "error"] as const) {
      await globalRef.set(
        `__console_${level}`,
        new ivm.Reference((...args: any[]) =>
          sandboxContext.console[level](...args)
        )
      );
    }
    await vmContext.eval(`
      globalThis.console = {};
      for (const lvl of ["log", "info", "warn", "error"]) {
        globalThis.console[lvl] = (...a) =>
          globalThis["__console_" + lvl].apply(undefined, a,
            { arguments: { copy: true } });
      }
    `);

    tracer.emitEvent("context_setup_complete", {});
  }

  /**
   * Get default quotas
   */
  getDefaultQuotas(): ResourceQuotas {
    return { ...this.defaultQuotas };
  }

  /**
   * Get default policy
   */
  getDefaultPolicy(): SecurityPolicy {
    return { ...this.defaultPolicy };
  }

  /**
   * Rewrite the last bare expression-statement in a script to use `return`
   */
  private injectReturnForLastExpression(script: string): string {
    const lines = script.split("\n");

    // Track whether we're inside a string literal by counting unescaped quotes
    // Simple heuristic: if the script's last top-level statement ends with });
    // or }); patterns, it's a call expression — don't inject return anywhere.
    // Walk backwards only through "real" top-level lines.
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (
        !trimmed ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        // Inside a multiline string argument — lines that don't look like JS
        // (no semicolons, no JS keywords, not a closing bracket line)
        // but DO contain characters typical of string content mid-injection.
        // Safest: skip any line that contains a quote char mid-content.
        (trimmed.includes('"') && !trimmed.startsWith('"') && !trimmed.endsWith('";') && !trimmed.endsWith('",'))
      ) {
        continue;
      }

      const statementKeywords =
        /^(function\s|class\s|const\s|let\s|var\s|if\s*[(]|for\s*[(]|while\s*[(]|do\s*[{]|switch\s*[(]|try\s*[{]|return\s|throw\s|break;|continue;|import\s|export\s|[{]|})/;
      if (statementKeywords.test(trimmed)) {
        break;
      }

      lines[i] = lines[i].replace(trimmed, `return ${trimmed}`);
      return lines.join("\n");
    }

    return script;
  }
}
