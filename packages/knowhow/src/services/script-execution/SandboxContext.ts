import { AIClient } from "../../clients";
import { ScriptTracer } from "./ScriptTracer";
import { ScriptPolicyEnforcer } from "./ScriptPolicy";
import { Artifact, QuotaUsage } from "./types";
import { Message } from "../../clients/types";
import { ToolsService } from "../Tools";

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
   * Console implementation that captures output
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
      const result = await this.toolsService.callTool(toolCall);

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
   * Call LLM through the clients service
   */
  async llm(
    messages: Message[],
    options: {
      model?: string;
      maxTokens?: number;
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
        max_tokens: options.maxTokens,
      };

      // Detect provider from model or use default
      const response = await this.clients.createCompletion(
        "",
        completionOptions
      );

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
