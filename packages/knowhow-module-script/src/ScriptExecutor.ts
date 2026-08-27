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
import { fork } from "child_process";
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
    // isolated-vm requires a memory limit; caller-facing usage limits are opt-in.
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

    // If --no-node-snapshot is not set (e.g. knowhow runs directly as a
    // Ghostty child for TCC permission inheritance), fork a worker that
    // carries the flag so isolated-vm can load, and bridge tool/llm/agent
    // calls back to this process's live ToolsService. This applies to every
    // execution path, including programmatic executeScript tool calls that do
    // not provide an onEvent listener.
    const needsWorker =
      parseInt(process.version.slice(1).split(".")[0], 10) >= 20 &&
      !process.execArgv.includes("--no-node-snapshot");
    if (needsWorker) {
      return this.executeViaWorker(request);
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

      const result = await this.executeWithTimeout(
        request.script,
        context,
        quotas.maxExecutionTimeMs,
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
   * Execute a script, adding timeout protection only when explicitly requested.
   */
  private async executeWithTimeout(
    script: string,
    context: SandboxContext,
    timeoutMs: number | undefined,
    tracer: ScriptTracer,
    policyEnforcer: ScriptPolicyEnforcer
  ): Promise<any> {
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return this.executeScriptSecure(script, context, tracer, policyEnforcer);
    }

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

    await exposeAsync("createArtifact", (name, content, type) =>
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
   * Execute a script via a forked worker process that carries --no-node-snapshot.
   *
   * Used when the current process was started WITHOUT --no-node-snapshot (e.g.
   * when knowhow runs directly as a Ghostty child for macOS TCC permission
   * inheritance). The worker runs isolated-vm in its own process and bridges
   * tool/llm/agent calls back here via IPC so the live ToolsService is used.
   */
  private async executeViaWorker(request: ExecutionRequest): Promise<ExecutionResult> {
    const path = require("path") as typeof import("path");
    const tracer = new ScriptTracer();

    let unsubscribe: (() => void) | undefined;
    if (request.onEvent) {
      unsubscribe = tracer.onEvent(request.onEvent);
    }

    const quotas = { ...this.defaultQuotas, ...request.quotas };
    const policy = { ...this.defaultPolicy, ...request.policy };
    const policyEnforcer = new ScriptPolicyEnforcer(quotas, policy);

    // Collect tool names for the worker's shorthand globals
    let availableTools: string[] = [];
    try {
      const context = new SandboxContext(
        this.toolsService,
        this.clients,
        tracer,
        policyEnforcer
      );
      availableTools = context.listToolNames();
    } catch {
      availableTools = [];
    }

    tracer.emitEvent("execution_start", {
      scriptLength: request.script.length,
      quotas,
      via: "worker",
    });

    return new Promise<ExecutionResult>((resolve) => {
      // Resolve the compiled worker JS (ts_build mirrors src structure)
      const workerJs = path.join(__dirname, "script-worker.js");

      const child = fork(workerJs, [], {
        execArgv: ["--no-node-snapshot", "--enable-source-maps"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      // Forward child stderr to our stderr for visibility
      child.stderr?.pipe(process.stderr);

      const finish = (result: ExecutionResult) => {
        unsubscribe?.();
        if (!child.killed) child.kill();
        resolve(result);
      };

      child.on("message", async (msg: any) => {
        if (msg.type === "ready") {
          // Worker is up — send the script
          child.send({
            type: "run",
            script: request.script,
            args: request.args ?? {},
            quotas,
            policy,
            availableTools,
          });
        } else if (msg.type === "event") {
          // Relay trace events to the caller's onEvent handler
          tracer.emitEvent(msg.event.type, msg.event.data ?? {});
        } else if (msg.type === "tool_call") {
          // Bridge: run the tool in this process using the live ToolsService
          try {
            policyEnforcer.recordToolCall();
            tracer.emitEvent("tool_call_start", { toolName: msg.toolName });
            const toolCall = {
              id: `script-worker-tool-${Date.now()}`,
              type: "function" as const,
              function: {
                name: msg.toolName,
                arguments: JSON.stringify(msg.params ?? {}),
              },
            };
            const rawResult = await this.toolsService.callTool(toolCall);
            const result =
              rawResult && typeof rawResult === "object" && "functionResp" in rawResult
                ? rawResult.functionResp
                : rawResult;
            tracer.emitEvent("tool_call_success", { toolName: msg.toolName });
            child.send({ type: "tool_result", id: msg.id, result: result ?? null });
          } catch (err: any) {
            tracer.emitEvent("tool_call_error", { toolName: msg.toolName, error: err?.message });
            child.send({ type: "tool_result", id: msg.id, result: null, error: err?.message ?? String(err) });
          }
        } else if (msg.type === "llm_call") {
          // Bridge: run LLM call via the live AIClient
          try {
            const result = await this.clients.createCompletion("", {
              messages: msg.messages,
              model: msg.options?.model,
              max_tokens: msg.options?.maxTokens,
            });
            child.send({ type: "llm_result", id: msg.id, result: result ?? null });
          } catch (err: any) {
            child.send({ type: "llm_result", id: msg.id, result: null, error: err?.message ?? String(err) });
          }
        } else if (msg.type === "agent_call") {
          // Bridge: run agent call via callTool('agentCall', ...)
          try {
            const toolCall = {
              id: `script-worker-agent-${Date.now()}`,
              type: "function" as const,
              function: {
                name: "agentCall",
                arguments: JSON.stringify({ agentName: msg.agentName, query: msg.query }),
              },
            };
            const rawResult = await this.toolsService.callTool(toolCall);
            const result =
              rawResult && typeof rawResult === "object" && "functionResp" in rawResult
                ? rawResult.functionResp
                : rawResult;
            child.send({ type: "agent_result", id: msg.id, result: result ?? null });
          } catch (err: any) {
            child.send({ type: "agent_result", id: msg.id, result: null, error: err?.message ?? String(err) });
          }
        } else if (msg.type === "done") {
          finish({
            success: true,
            error: null,
            result: msg.result,
            trace: tracer.getTrace(),
            artifacts: [],
            consoleOutput: [],
          });
        } else if (msg.type === "error") {
          tracer.emitEvent("execution_error", { error: msg.error });
          finish({
            success: false,
            error: msg.error,
            result: null,
            trace: tracer.getTrace(),
            artifacts: [],
            consoleOutput: [],
          });
        }
      });

      child.on("error", (err) => {
        tracer.emitEvent("execution_error", { error: err.message });
        finish({
          success: false,
          error: err.message,
          result: null,
          trace: tracer.getTrace(),
          artifacts: [],
          consoleOutput: [],
        });
      });

      child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          finish({
            success: false,
            error: `Script worker exited with code ${code}`,
            result: null,
            trace: tracer.getTrace(),
            artifacts: [],
            consoleOutput: [],
          });
        }
      });
    });
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
