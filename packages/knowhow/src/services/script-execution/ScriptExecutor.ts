import ivm from "isolated-vm";
import { services, ToolsService } from "../../services";
import { AIClient, Clients } from "../../clients";
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
    // Get Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    
    // Check if Node.js 20+ and --no-node-snapshot flag is required
    if (majorVersion >= 20) {
      const hasNoNodeSnapshot = process.execArgv.includes('--no-node-snapshot');
      
      if (!hasNoNodeSnapshot) {
        const errorMessage = [
          `Node.js ${nodeVersion} detected. The executeScript tool requires the --no-node-snapshot flag for isolated-vm compatibility.`,
          '',
          'This flag is automatically included when running knowhow commands via the CLI (e.g., `knowhow agent`, `knowhow chat`).',
          '',
          'If you are programmatically using knowhow or running custom scripts:',
          '1. Start your application with: node --no-node-snapshot your-app.js',
          '2. Or update your package.json scripts to include the flag:',
          '   "scripts": {',
          '     "start": "node --no-node-snapshot dist/index.js"',
          '   }',
          '',
          'Note: This flag is required for Node.js 20+ to ensure isolated-vm works correctly.'
        ].join('\n');
        
        throw new Error(errorMessage);
      }
    }
  }

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
  ) {
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
        promise: true,
        copy: true,
      });

      tracer.emitEvent("script_execution_complete", {
        resultType: typeof result,
      });

      return result;
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

    const globalRef = vmContext.global;
    await globalRef.set("globalThis", globalRef.derefInto());

    // Helper function to expose async host functions
    const exposeAsync = async (
      name: string,
      fn: (...a: any[]) => Promise<any>
    ) => {
      await globalRef.set(
        `__host_${name}`,
        new ivm.Reference(async (...args: any[]) => {
          const result = await fn(...args);
          return new ivm.ExternalCopy(result).copyInto();
        })
      );
      await vmContext.eval(`
        globalThis.${name} = (...a) =>
          __host_${name}.apply(undefined, a,
            { arguments: { copy: true }, result: { promise: true, copy: true } });
      `);
    };

    // Helper function to expose sync host functions
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

    // Expose async sandbox functions
    await exposeAsync("callTool", async (tool, params) => {
      const { functionResp } = await sandboxContext.callTool(
        tool as string,
        params
      );
      return functionResp;
    });
    await exposeAsync("llm", (messages, options) =>
      sandboxContext.llm(messages, options || {})
    );
    await exposeAsync("sleep", (ms) => sandboxContext.sleep(ms));

    // Expose sync sandbox functions
    await exposeSync("createArtifact", (name, content, type) =>
      sandboxContext.createArtifact(name as string, content, type)
    );
    await exposeSync("getQuotaUsage", () => sandboxContext.getQuotaUsage());

    // Set up console bridging with individual function references
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
