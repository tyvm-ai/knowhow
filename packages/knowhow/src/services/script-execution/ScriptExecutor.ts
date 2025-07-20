import ivm from "isolated-vm";
import { Tools } from "../../services";
import { Clients } from "../../clients";
import { SandboxContext } from "./SandboxContext";
import { ScriptTracer } from "./ScriptTracer";
import { ScriptPolicyEnforcer } from "./ScriptPolicy";
import {
  ExecutionRequest,
  ExecutionResult,
  ResourceQuotas,
  SecurityPolicy,
  ExecutionTrace,
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
      "execCommand", // Dangerous system commands
      "writeFileChunk", // File system write access
      "patchFile", // File system modification
    ],
    maxScriptLength: 50000, // 50KB
    allowNetworkAccess: false,
    allowFileSystemAccess: false,
  };

  constructor(
    private toolsService: typeof Tools | null = null,
    private clients: typeof Clients | null = null
  ) {}

  /**
   * Execute a TypeScript script in sandbox
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const tracer = new ScriptTracer();
    const quotas = { ...this.defaultQuotas, ...request.quotas };
    const policy = { ...this.defaultPolicy, ...request.policy };
    const policyEnforcer = new ScriptPolicyEnforcer(quotas, policy);

    tracer.emitEvent("execution_start", {
      scriptLength: request.script.length,
      quotas,
      policy: {
        ...policy,
        // Don't log the full tool lists
        allowlistedTools: `${policy.allowlistedTools.length} tools`,
        denylistedTools: `${policy.denylistedTools.length} tools`,
      },
    });

    try {
      // Validate script
      const validation = policyEnforcer.validateScript(request.script);
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
      const startTime = Date.now();
      const timeoutMs = quotas.maxExecutionTimeMs;

      const result = await this.executeWithTimeout(
        request.script,
        context,
        timeoutMs,
        tracer,
        policyEnforcer
      );

      const executionTime = Date.now() - startTime;
      tracer.emitEvent("execution_complete", {
        executionTimeMs: executionTime,
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

      // Use isolated-vm for secure execution
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
  ): Promise<any> {
    tracer.emitEvent("secure_execution_start", {
      note: "Using isolated-vm for secure execution",
    });

    // Create isolated VM instance with memory limit
    const isolate = new ivm.Isolate({
      memoryLimit: policyEnforcer.getQuotas().maxMemoryMb,
    });

    try {
      // Create new context within the isolate
      const vmContext = await isolate.createContext();

      tracer.emitEvent("vm_context_created", {});

      // Set up the global environment in the isolated context
      await this.setupIsolatedContext(vmContext, context, tracer);

      tracer.emitEvent("script_compilation_start", {});

      // Compile the script
      const wrappedScript = `
        (async function() {
          "use strict";
          ${script}
        })()
      `;

      const compiledScript = await isolate.compileScript(wrappedScript);

      tracer.emitEvent("script_compilation_complete", {});
      tracer.emitEvent("script_execution_start", {});

      // Execute the script and get the result
      const result = await compiledScript.run(vmContext, {
        timeout: policyEnforcer.getQuotas().maxExecutionTimeMs,
      });

      tracer.emitEvent("script_execution_complete", {
        resultType: typeof result,
      });

      // Copy the result back to the main thread if it's transferable
      return (await result?.copy?.()) ?? result;
    } finally {
      // Clean up the isolate
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

    // Set up safe global objects
    const global = vmContext.global;

    // Add safe built-ins
    await global.set("JSON", JSON);
    await global.set("Math", Math);
    await global.set("Date", Date);
    await global.set("Array", Array);
    await global.set("Object", Object);
    await global.set("String", String);
    await global.set("Number", Number);
    await global.set("Boolean", Boolean);
    await global.set("Promise", Promise);

    // Add console
    await global.set(
      "console",
      new ivm.Reference({
        log: new ivm.Callback((...args: any[]) => {
          sandboxContext.console.log(...args);
        }),
        error: new ivm.Callback((...args: any[]) => {
          sandboxContext.console.error(...args);
        }),
        warn: new ivm.Callback((...args: any[]) => {
          sandboxContext.console.warn(...args);
        }),
        info: new ivm.Callback((...args: any[]) => {
          sandboxContext.console.info(...args);
        }),
      })
    );

    // Add sandbox functions
    await global.set(
      "callTool",
      new ivm.Callback(async (toolName: string, parameters: any) => {
        return await sandboxContext.callTool(toolName, parameters);
      })
    );

    await global.set(
      "llm",
      new ivm.Callback(async (messages: any[], options: any) => {
        return await sandboxContext.llm(messages, options || {});
      })
    );

    await global.set(
      "createArtifact",
      new ivm.Callback((name: string, content: string, type?: string) => {
        return sandboxContext.createArtifact(name, content, type as any);
      })
    );

    await global.set(
      "getQuotaUsage",
      new ivm.Callback(() => {
        return sandboxContext.getQuotaUsage();
      })
    );

    tracer.emitEvent("context_setup_complete", {});
  }

  /**
   * Legacy fallback execution method
   */
  private async executeScriptFallback(
    script: string,
    context: SandboxContext,
    tracer: ScriptTracer,
    policyEnforcer: ScriptPolicyEnforcer
  ): Promise<any> {
    // This is a fallback method that could use vm2 or other sandboxing
    throw new Error("Isolated-vm execution failed, no fallback available");
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
}
