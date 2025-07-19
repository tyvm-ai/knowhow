import { TraceEvent, TraceMetrics, ExecutionTrace, QuotaUsage } from "./types";

/**
 * Handles tracing and monitoring of script execution
 */
export class ScriptTracer {
  private events: TraceEvent[] = [];
  private metrics: TraceMetrics;
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
    this.metrics = {
      executionTimeMs: 0,
      toolCallCount: 0,
      llmCallCount: 0,
      tokenUsage: {
        prompt: 0,
        completion: 0,
        total: 0,
      },
      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
      },
      costUsd: 0,
    };
  }

  /**
   * Emit a trace event
   */
  emitEvent(type: string, data: any): void {
    const event: TraceEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      timestamp: Date.now(),
      data: this.sanitizeEventData(data),
    };

    this.events.push(event);
    this.updateMetrics(event);
  }

  /**
   * Record cost for tracking
   */
  recordCost(costUsd: number): void {
    this.metrics.costUsd += costUsd;
    this.emitEvent("cost_recorded", {
      costUsd,
      totalCost: this.metrics.costUsd,
    });
  }

  /**
   * Get current quota usage
   */
  getCurrentQuota(): QuotaUsage {
    return {
      toolCalls: this.metrics.toolCallCount,
      tokens: this.metrics.tokenUsage.total,
      executionTimeMs: Date.now() - this.startTime,
      costUsd: this.metrics.costUsd,
    };
  }

  /**
   * Get all trace events
   */
  getEvents(): TraceEvent[] {
    return [...this.events];
  }

  /**
   * Get current metrics
   */
  getMetrics(): TraceMetrics {
    return {
      ...this.metrics,
      executionTimeMs: Date.now() - this.startTime,
    };
  }

  /**
   * Generate execution trace
   */
  getTrace(): ExecutionTrace {
    return {
      id: `trace-${Date.now()}`,
      startTime: this.startTime,
      endTime: Date.now(),
      events: this.getEvents(),
      metrics: this.getMetrics(),
      success: !this.events.some((e) => e.type.includes("error")),
      error: this.getLastError(),
    };
  }

  /**
   * Clear all events and reset metrics
   */
  reset(): void {
    this.events = [];
    this.startTime = Date.now();
    this.metrics = {
      executionTimeMs: 0,
      toolCallCount: 0,
      llmCallCount: 0,
      tokenUsage: {
        prompt: 0,
        completion: 0,
        total: 0,
      },
      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
      },
      costUsd: 0,
    };
  }

  /**
   * Update metrics based on events
   */
  private updateMetrics(event: TraceEvent): void {
    switch (event.type) {
      case "tool_call_start":
        this.metrics.toolCallCount++;
        break;

      case "llm_call_start":
        this.metrics.llmCallCount++;
        break;

      case "llm_call_success":
        if (event.data && event.data.usage) {
          const usage = event.data.usage;
          this.metrics.tokenUsage.prompt += usage.prompt_tokens || 0;
          this.metrics.tokenUsage.completion += usage.completion_tokens || 0;
          this.metrics.tokenUsage.total += usage.total_tokens || 0;
        }
        break;
    }

    // Update memory usage if available
    if (typeof process !== "undefined" && process.memoryUsage) {
      const memUsage = process.memoryUsage();
      this.metrics.memoryUsage.heapUsed = memUsage.heapUsed;
      this.metrics.memoryUsage.heapTotal = memUsage.heapTotal;
    }
  }

  /**
   * Get the last error from events
   */
  private getLastError(): string | undefined {
    const errorEvents = this.events
      .filter((e) => e.type.includes("error"))
      .reverse();

    if (errorEvents.length > 0) {
      const lastError = errorEvents[0];
      return (
        lastError.data?.error || lastError.data?.message || "Unknown error"
      );
    }

    return undefined;
  }

  /**
   * Sanitize event data to prevent sensitive information leaks
   */
  private sanitizeEventData(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === "string") {
      // Truncate very long strings
      return data.length > 1000
        ? data.substring(0, 1000) + "...[TRUNCATED]"
        : data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeEventData(item));
    }

    if (typeof data === "object") {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(data)) {
        // Redact sensitive keys
        if (this.isSensitiveKey(key)) {
          sanitized[key] = "[REDACTED]";
        } else if (key === "parameters" && typeof value === "object") {
          // Special handling for tool parameters
          sanitized[key] = this.sanitizeParameters(value);
        } else {
          sanitized[key] = this.sanitizeEventData(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  /**
   * Check if a key contains sensitive information
   */
  private isSensitiveKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    const sensitivePatterns = [
      "password",
      "secret",
      "token",
      "key",
      "auth",
      "credential",
      "private",
      "confidential",
    ];

    return sensitivePatterns.some((pattern) => lowerKey.includes(pattern));
  }

  /**
   * Sanitize tool parameters
   */
  private sanitizeParameters(params: any): any {
    if (!params || typeof params !== "object") {
      return params;
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(params)) {
      if (this.isSensitiveKey(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string" && value.length > 500) {
        sanitized[key] = value.substring(0, 500) + "...[TRUNCATED]";
      } else {
        sanitized[key] = this.sanitizeEventData(value);
      }
    }
    return sanitized;
  }
}
