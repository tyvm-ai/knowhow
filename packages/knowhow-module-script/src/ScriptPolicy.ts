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
  private complexityLimit: number = 150; // Arbitrary limit for script complexity

  constructor(
    private quotas: ResourceQuotas,
    private policy: SecurityPolicy,
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
    if (this.quotas.maxToolCalls !== undefined &&
        this.usage.toolCalls >= this.quotas.maxToolCalls) {
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
    if (this.quotas.maxTokens !== undefined &&
        this.usage.tokens + tokens > this.quotas.maxTokens) {
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
    if (this.quotas.maxExecutionTimeMs !== undefined &&
        currentTimeMs > this.quotas.maxExecutionTimeMs) {
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
    if (this.quotas.maxCostUsd !== undefined &&
        this.usage.costUsd + additionalCost > this.quotas.maxCostUsd) {
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
  validateScript(scriptContent: string, allowNetworkAccess?: boolean): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check script length
    if (scriptContent.length > this.policy.maxScriptLength) {
      issues.push(`Script too long: ${scriptContent.length} > ${this.policy.maxScriptLength}`);
    }

    // Strip string literals and comments before checking for banned globals
    // so that names appearing in strings/comments/variable names don't false-positive.
    const stripped = stripStringsAndComments(scriptContent);

    // eval() is never available in isolated-vm — always flag it.
    // We match `eval(` as a standalone call, not as part of a longer identifier
    // like `evaluate(` or `evaluateScore(`.
    if (/(?<![a-zA-Z0-9_$])eval\s*\(/.test(stripped)) {
      issues.push(
        "eval() is not available in the script sandbox.\n" +
        "isolated-vm does not expose eval for security reasons.\n" +
        "Instead, pass your script source directly to startScript() or executeScript()."
      );
    }

    // fetch() is only available when allowNetworkAccess is explicitly true.
    if (!allowNetworkAccess && /(?<![a-zA-Z0-9_$])fetch\s*\(/.test(stripped)) {
      issues.push(
        "fetch() is not available in the script sandbox (network access is disabled by default).\n" +
        "To enable network access, pass allowNetworkAccess: true to startScript() or executeScript(),\n" +
        "or use the --allow-network flag with 'knowhow script'.\n" +
        "Note: network access is a security risk; only enable it for trusted scripts."
      );
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

/**
 * Strip string literals (single, double, template) and comments (line and block)
 * from JavaScript/TypeScript source before pattern-matching for banned globals.
 *
 * This prevents false positives when `eval` or `fetch` appear inside:
 *   - string literals:  const url = "https://example.com/fetchData"
 *   - comments:         // fetchData is called below
 *   - variable names:   function fetchUserData() { ... }  ← NOT stripped (word-boundary regex handles this)
 *   - template strings: `result of eval: ${x}`
 *
 * We replace each stripped region with a space of equal length so that
 * character offsets remain accurate (useful for future error reporting).
 */
function stripStringsAndComments(src: string): string {
  // One pass over the source, character by character.
  let out = "";
  let i = 0;
  const len = src.length;

  while (i < len) {
    // Line comment: // …
    if (src[i] === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < len && src[i] !== "\n") i++;
      out += " ".repeat(i - start);
      continue;
    }
    // Block comment: /* … */
    if (src[i] === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2; // skip closing */
      out += " ".repeat(i - start);
      continue;
    }
    // String literals: 'x', "x", `x` (with escape handling; no tagged template needed)
    if (src[i] === "'" || src[i] === '"' || src[i] === "`") {
      const quote = src[i];
      const start = i;
      i++; // skip opening quote
      while (i < len) {
        if (src[i] === "\\" && quote !== "`") {
          i += 2; // skip escape sequence
          continue;
        }
        if (src[i] === "\\" && quote === "`") {
          i += 2; // skip escape in template literal
          continue;
        }
        // Template literal expression ${…} — we leave the content as-is
        // (it's real code that should still be checked)
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          // replace just the string portion up to here, emit rest normally
          out += " ".repeat(i - start);
          // skip past ${ and find matching }
          i += 2;
          let depth = 1;
          while (i < len && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            out += depth > 0 ? src[i] : " ";
            i++;
          }
          // now continue scanning the template body after the expression
          // (need to re-enter the quote loop for the closing backtick)
          // Rather than special-casing, just break and let outer loop handle rest.
          // We approximate: mark the remainder of the template as spaces later.
          // Simple approach: restart inner loop at current i still inside template.
          while (i < len) {
            if (src[i] === "\\" ) { i += 2; continue; }
            if (src[i] === "`") { i++; break; }
            if (src[i] === "$" && src[i + 1] === "{") {
              i += 2;
              let d = 1;
              while (i < len && d > 0) {
                if (src[i] === "{") d++;
                else if (src[i] === "}") d--;
                i++;
              }
              continue;
            }
            i++;
          }
          // The segment after ${ was emitted literally (real code); closing ` eaten.
          break;
        }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      // Replace the whole string literal span with spaces (except template expressions above)
      if (quote !== "`") {
        out += " ".repeat(i - start);
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}
