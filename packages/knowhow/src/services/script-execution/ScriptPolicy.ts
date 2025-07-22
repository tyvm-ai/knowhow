import { 
  ResourceQuotas, 
  SecurityPolicy,
  QuotaUsage,
  PolicyViolation 
} from './types';

/**
 * Enforces security policies and resource quotas for script execution
 */
export class ScriptPolicyEnforcer {
  private usage: QuotaUsage;
  private violations: PolicyViolation[] = [];

  constructor(
    private quotas: ResourceQuotas,
    private policy: SecurityPolicy
  ) {
    this.usage = {
      toolCalls: 0,
      tokens: 0,
      executionTimeMs: 0,
      costUsd: 0
    };
  }

  /**
   * Check if a tool call is allowed
   */
  checkToolCall(toolName: string): boolean {
    // Check if tool is in denylist
    if (this.policy.denylistedTools && this.policy.denylistedTools.includes(toolName)) {
      this.recordViolation('tool_denied', `Tool '${toolName}' is in denylist`);
      return false;
    }

    // Check if tool is in allowlist (if allowlist is defined and not empty)
    if (this.policy.allowlistedTools && this.policy.allowlistedTools.length > 0 && 
        !this.policy.allowlistedTools.includes(toolName)) {
      this.recordViolation('tool_not_allowed', `Tool '${toolName}' is not in allowlist`);
      return false;
    }

    // Check quota
    if (this.usage.toolCalls >= this.quotas.maxToolCalls) {
      this.recordViolation('quota_exceeded', 'Maximum tool calls exceeded');
      return false;
    }

    return true;
  }

  /**
   * Record a tool call
   */
  recordToolCall(): void {
    this.usage.toolCalls++;
  }

  /**
   * Check if token usage is allowed
   */
  checkTokenUsage(tokens: number): boolean {
    if (this.usage.tokens + tokens > this.quotas.maxTokens) {
      this.recordViolation('quota_exceeded', 'Maximum tokens would be exceeded');
      return false;
    }
    return true;
  }

  /**
   * Record token usage
   */
  recordTokenUsage(tokens: number): void {
    this.usage.tokens += tokens;
  }

  /**
   * Check if execution time limit is exceeded
   */
  checkExecutionTime(currentTimeMs: number): boolean {
    if (currentTimeMs > this.quotas.maxExecutionTimeMs) {
      this.recordViolation('quota_exceeded', 'Maximum execution time exceeded');
      return false;
    }
    this.usage.executionTimeMs = currentTimeMs;
    return true;
  }

  /**
   * Check if cost limit is exceeded
   */
  checkCost(additionalCost: number): boolean {
    if (this.usage.costUsd + additionalCost > this.quotas.maxCostUsd) {
      this.recordViolation('quota_exceeded', 'Maximum cost would be exceeded');
      return false;
    }
    return true;
  }

  /**
   * Record cost usage
   */
  recordCost(cost: number): void {
    this.usage.costUsd += cost;
  }

  /**
   * Get current usage
   */
  getUsage(): QuotaUsage {
    return { ...this.usage };
  }

  /**
   * Get current quotas
   */
  getQuotas(): ResourceQuotas {
    return { ...this.quotas };
  }

  /**
   * Get all policy violations
   */
  getViolations(): PolicyViolation[] {
    return [...this.violations];
  }

  /**
   * Check if there are any violations
   */
  hasViolations(): boolean {
    return this.violations.length > 0;
  }

  /**
   * Get the most recent violation
   */
  getLastViolation(): PolicyViolation | undefined {
    return this.violations[this.violations.length - 1];
  }

  /**
   * Reset usage counters
   */
  resetUsage(): void {
    this.usage = {
      toolCalls: 0,
      tokens: 0,
      executionTimeMs: 0,
      costUsd: 0
    };
  }

  /**
   * Reset violations
   */
  resetViolations(): void {
    this.violations = [];
  }

  /**
   * Validate script content for security issues
   */
  validateScript(scriptContent: string): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for dangerous patterns
    const dangerousPatterns = [
      /require\s*\(/gi,           // Node.js require
      /import\s+.*\s+from/gi,     // ES6 imports (should be handled by bundler)
      /process\./gi,              // Process access
      /global\./gi,               // Global object access
      /eval\s*\(/gi,              // eval calls
      /Function\s*\(/gi,          // Function constructor
      /setTimeout/gi,             // setTimeout
      /setInterval/gi,            // setInterval
      /fetch\s*\(/gi,             // Direct fetch calls
      /XMLHttpRequest/gi,         // XHR
      /WebSocket/gi,              // WebSocket
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(scriptContent)) {
        issues.push(`Potentially dangerous pattern detected: ${pattern.source}`);
      }
    }

    // Check script length
    if (scriptContent.length > this.policy.maxScriptLength) {
      issues.push(`Script too long: ${scriptContent.length} > ${this.policy.maxScriptLength}`);
    }

    // Check for excessive complexity (rough heuristic)
    const complexityIndicators = [
      /for\s*\(/gi,
      /while\s*\(/gi,
      /function\s+\w+/gi,
      /=>\s*{/gi,
      /if\s*\(/gi,
    ];

    let complexityScore = 0;
    for (const indicator of complexityIndicators) {
      const matches = scriptContent.match(indicator);
      complexityScore += matches ? matches.length : 0;
    }

    if (complexityScore > 50) {
      issues.push(`Script complexity too high: ${complexityScore} constructs detected`);
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * Record a policy violation
   */
  private recordViolation(type: 'quota_exceeded' | 'tool_denied' | 'tool_not_allowed' | 'script_validation', message: string): void {
    const violation: PolicyViolation = {
      id: `violation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      message,
      timestamp: Date.now(),
      usage: { ...this.usage }
    };

    this.violations.push(violation);
  }
}
