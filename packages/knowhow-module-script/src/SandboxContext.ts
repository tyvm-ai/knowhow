import { AIClient } from "@tyvm/knowhow/ts_build/src/clients";
import { ScriptTracer } from "./ScriptTracer";
import { ScriptPolicyEnforcer } from "./ScriptPolicy";
import { Artifact, QuotaUsage } from "./types";
import { Message } from "@tyvm/knowhow/ts_build/src/clients/types";
import { ToolsService } from "@tyvm/knowhow/ts_build/src/services/Tools";

/**
 * Provides the execution context for scripts with controlled access to tools and AI
 */
export class SandboxContext {
  private artifacts: Artifact[] = [];
  private consoleOutput: string[] = [];

  constructor(
    private toolsService: ToolsService,
    private clients: AIClient,
    private tracer: ScriptTracer,
    private policyEnforcer: ScriptPolicyEnforcer
  ) {}

  /**
   * Console implementation that captures output and emits trace events.
   *
   * NOTE: Nothing is written directly to process.stdout / process.stderr here.
   * Callers (e.g. the CLI `script` command) should subscribe to tracer events
   * via `tracer.onEvent(listener)` and render console_log / console_error /
   * console_warn / console_info events however they like.  This keeps the
   * sandbox decoupled from stdout so that programmatic consumers of
   * ScriptExecutor can handle output in their own way.
   */
  console = {
    log: (...args: any[]) => {
      const message = args
        .map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        )
        .join(" ");
      this.consoleOutput.push(`[LOG] ${message}`);
      this.tracer.emitEvent("console_log", { message, args });
    },

    error: (...args: any[]) => {
      const message = args
        .map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        )
        .join(" ");
      this.consoleOutput.push(`[ERROR] ${message}`);
      this.tracer.emitEvent("console_error", { message, args });
    },

    warn: (...args: any[]) => {
      const message = args
        .map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        )
        .join(" ");
      this.consoleOutput.push(`[WARN] ${message}`);
      this.tracer.emitEvent("console_warn", { message, args });
    },

    info: (...args: any[]) => {
      const message = args
        .map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg) : String(arg)
        )
        .join(" ");
      this.consoleOutput.push(`[INFO] ${message}`);
      this.tracer.emitEvent("console_info", { message, args });
    },
  };

  /**
   * List every function registered on the script's ToolsService. Prompt-visible
   * tools are intentionally a separate concern from script tool access.
   */
  listToolNames(): string[] {
    try {
      const names =
        typeof this.toolsService.getFunctionNames === "function"
          ? this.toolsService.getFunctionNames()
          : [];
      return Array.isArray(names) ? names : [];
    } catch {
      return [];
    }
  }

  /**
   * Call a tool through the tools service
   */
  async callTool(toolName: string, parameters: any): Promise<any> {
    // Check policy first
    if (!this.policyEnforcer.checkToolCall(toolName)) {
      throw new Error(`Tool call '${toolName}' blocked by policy`);
    }

    if (toolName === "executeScript") {
      throw new Error("Nested script execution is not allowed in sandbox");
    }

    this.tracer.emitEvent("tool_call_start", {
      toolName,
      parameters: this.sanitizeForLogging(parameters),
    });

    try {
      // Record the tool call
      this.policyEnforcer.recordToolCall();

      // Create a proper ToolCall object
      const toolCall = {
        id: `script-tool-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`,
        type: "function" as const,
        function: {
          name: toolName,
          arguments: JSON.stringify(parameters),
        },
      };

      // Call the actual tool through the Tools service
      const result = await this.toolsService.callTool(
        toolCall,
        this.toolsService.getFunctionNames()
      );

      this.tracer.emitEvent("tool_call_success", {
        toolName,
        result: this.sanitizeForLogging(result),
      });

      return result;
    } catch (error) {
      this.tracer.emitEvent("tool_call_error", {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Run another registered agent as a graph node. Unlike `llm()` (a single
   * stateless completion), the target agent can use tools, loop, and maintain
   * its own context. Returns the agent's final answer as a plain string, so it
   * composes cleanly inside a graph (fan-out with Promise.all, gates on the
   * result, feedback loops, etc.).
   *
   * This is a thin, ergonomic wrapper over `callTool('agentCall', ...)` that
   * unwraps `{ functionResp }` for you and normalizes the result to a string.
   */
  async agent(agentName: string, query: string): Promise<string> {
    if (typeof agentName !== "string" || !agentName) {
      throw new Error("agent(agentName, query): agentName must be a non-empty string");
    }
    if (typeof query !== "string") {
      query = String(query);
    }

    this.tracer.emitEvent("agent_call_start", { agentName });

    const result = await this.callTool("agentCall", { agentName, query });
    // callTool returns the raw tool result; agentCall's answer is in functionResp.
    // As of the cost-tracking change, agentCall resolves { answer, costUsd }.
    const resp =
      result && typeof result === "object" && "functionResp" in result
        ? (result as any).functionResp
        : result;

    let answer: unknown = resp;
    let costUsd = 0;
    if (resp && typeof resp === "object" && "answer" in resp) {
      answer = (resp as any).answer;
      costUsd = Number((resp as any).costUsd) || 0;
    }

    const text =
      answer === null || answer === undefined
        ? ""
        : typeof answer === "string"
        ? answer
        : JSON.stringify(answer);

    // Account the subagent's spend against the script's cost budget.
    if (costUsd > 0) {
      if (!this.policyEnforcer.checkCost(costUsd)) {
        this.tracer.recordCost(costUsd);
        this.policyEnforcer.recordCost(costUsd);
        throw new Error(
          `Cost quota exceeded after agent '${agentName}' spent $${costUsd.toFixed(4)}`
        );
      }
      this.tracer.recordCost(costUsd);
      this.policyEnforcer.recordCost(costUsd);
    }

    this.tracer.emitEvent("agent_call_success", {
      agentName,
      answerLength: text.length,
      costUsd,
    });
    return text;
  }

  /**
   * Call LLM through the clients service
   */
  async llm(
    messages: Message[],
    options: {
      model?: string;
      maxTokens?: number;
      max_tokens?: number;
      temperature?: number;
    } = {}
  ) {
    const estimatedTokens = this.estimateTokens(messages);

    // Check token quota
    if (!this.policyEnforcer.checkTokenUsage(estimatedTokens)) {
      throw new Error("Token quota would be exceeded");
    }

    this.tracer.emitEvent("llm_call_start", {
      messageCount: messages.length,
      estimatedTokens,
      model: options.model,
      options: this.sanitizeForLogging(options),
    });

    try {
      // Record token usage
      this.policyEnforcer.recordTokenUsage(estimatedTokens);

      // Use the actual Clients service to make LLM calls
      const completionOptions = {
        model: options.model,
        messages,
        max_tokens: options.maxTokens ?? options.max_tokens,
      };

      // Detect provider from model or use default
      const response = await this.clients.createCompletion(
        "",
        completionOptions
      );

      // Account model spend against the cost budget.
      const cost = Number((response as any)?.usd_cost) || 0;
      if (cost > 0) {
        if (!this.policyEnforcer.checkCost(cost)) {
          this.tracer.recordCost(cost);
          this.policyEnforcer.recordCost(cost);
          throw new Error(
            `Cost quota would be exceeded by llm() call ($${cost.toFixed(4)})`
          );
        }
        this.tracer.recordCost(cost);
        this.policyEnforcer.recordCost(cost);
      }

      this.tracer.emitEvent("llm_call_success", {
        model: response.model,
        usage: response.usage,
        usdCost: response.usd_cost,
      });

      return response;
    } catch (error) {
      this.tracer.emitEvent("llm_call_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get current quota usage
   */
  getQuotaUsage(): QuotaUsage {
    return this.policyEnforcer.getUsage();
  }

  /**
   * Create an artifact
   */
  async createArtifact(
    name: string,
    content: string,
    type: "text" | "json" | "csv" | "html" | "markdown" = "text"
  ): Promise<Artifact> {
    const artifact: Artifact = {
      id: `artifact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      type,
      content,
      createdAt: new Date().toISOString(),
    };

    this.artifacts.push(artifact);

    this.tracer.emitEvent("artifact_created", {
      artifactId: artifact.id,
      name,
      type,
      contentLength: content.length,
    });

    return artifact;
  }

  async sleep(ms: number): Promise<void> {
    if (typeof ms !== "number" || ms < 0 || ms > 2000) {
      throw new Error("Invalid sleep duration, sleep must be >0 and <2000");
    }
    await new Promise((res) => setTimeout(res, ms));
    this.tracer.emitEvent("sleep", { durationMs: ms });
  }

  /**
   * Get all created artifacts
   */
  getArtifacts(): Artifact[] {
    return [...this.artifacts];
  }

  /**
   * Get console output
   */
  getConsoleOutput(): string[] {
    return [...this.consoleOutput];
  }

  /**
   * Estimate tokens for text (rough approximation)
   */
  private estimateTokens(messages: any[]): number {
    let totalText = "";
    for (const message of messages) {
      if (typeof message === "string") {
        totalText += message;
      } else if (message && typeof message.content === "string") {
        totalText += message.content;
      }
    }
    // Rough estimation: ~4 characters per token
    return Math.ceil(totalText.length / 4);
  }

  /**
   * Sanitize data for logging (remove sensitive information)
   */
  private sanitizeForLogging(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === "string") {
      // Truncate very long strings
      return data.length > 500 ? data.substring(0, 500) + "..." : data;
    }

    if (typeof data === "object") {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(data)) {
        // Skip potentially sensitive keys
        if (
          key.toLowerCase().includes("password") ||
          key.toLowerCase().includes("token") ||
          key.toLowerCase().includes("secret") ||
          key.toLowerCase().includes("key")
        ) {
          sanitized[key] = "[REDACTED]";
        } else {
          sanitized[key] = this.sanitizeForLogging(value);
        }
      }
      return sanitized;
    }

    return data;
  }
}
