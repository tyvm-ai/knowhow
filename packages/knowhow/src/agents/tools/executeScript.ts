import { Tool } from "../../clients/types";
import { ScriptExecutor } from "../../services/script-execution/ScriptExecutor";
import { Tools } from "../../services";
import { Clients } from "../../clients";

/**
 * Tool for executing TypeScript scripts in a secure sandbox
 */
export const executeScriptDef: Tool = {
  type: "function",
  function: {
    name: "executeScript",
    description: `Execute TypeScript code in a secure sandbox environment with access to tools and AI models.

  The script has access to:
  - callTool(toolName, parameters): Call any available tool
  - llm(messages, options): Make LLM calls
  - createArtifact(name, content, type): Create downloadable artifacts
  - console: Standard console logging
  - getQuotaUsage(): Check resource usage

  Example:
  \`\`\`typescript
  // Call a tool
  const searchResult = await callTool('textSearch', { searchTerm: 'hello world' });
  console.log('Search found:', searchResult);

  // Call LLM
  const response = await llm([
    { role: 'user', content: 'Explain quantum computing' }
  ], { model: 'gpt-4', maxTokens: 100 });
  console.log('LLM response:', response.choices[0].message.content);

  // Create an artifact
  createArtifact('summary.md', '# Summary\\nThis is a test', 'markdown');

  return { message: 'Script completed successfully' };
  \`\`\`

  Security: Scripts run in isolation with quotas on tool calls, tokens, time, and cost.`,

    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "The TypeScript code to execute",
        },
        maxToolCalls: {
          type: "number",
          description: "Maximum number of tool calls allowed (default: 50)",
        },
        maxTokens: {
          type: "number",
          description: "Maximum tokens for LLM calls (default: 10000)",
        },
        maxExecutionTimeMs: {
          type: "number",
          description:
            "Maximum execution time in milliseconds (default: 30000)",
        },
        maxCostUsd: {
          type: "number",
          description: "Maximum cost in USD (default: 1.0)",
        },
      },
      required: ["script"],
    },
  },
};

export const executeScript = async (
  { script, maxToolCalls, maxTokens, maxExecutionTimeMs, maxCostUsd },
  context
) => {
  try {
    // Create script executor with access to tools and clients
    const executor = new ScriptExecutor(Tools, Clients);

    // Execute the script
    const result = await executor.execute({
      script,
      quotas: {
        maxToolCalls: maxToolCalls || 50,
        maxTokens: maxTokens || 10000,
        maxExecutionTimeMs: maxExecutionTimeMs || 30000,
        maxCostUsd: maxCostUsd || 1.0,
        maxMemoryMb: 100,
      },
    });

    // If there were policy violations, include them in the response
    const violations = result.trace.events
      .filter((e) => e.type.includes("violation") || e.type.includes("error"))
      .map((e) => e.data);

    // Format the response
    return {
      success: result.success,
      result: result.result,
      error: result.error,
      artifacts: result.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        contentLength: a.content.length,
        createdAt: a.createdAt,
      })),
      consoleOutput: result.consoleOutput,
      metrics: result.trace.metrics,
      violations,
      executionTimeMs: result.trace.endTime - result.trace.startTime,
      quotaUsage: {
        toolCalls: result.trace.metrics.toolCallCount,
        tokens: result.trace.metrics.tokenUsage.total,
        costUsd: result.trace.metrics.costUsd,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: null,
      artifacts: [],
      consoleOutput: [],
      metrics: null,
      violations: [],
      executionTimeMs: 0,
      quotaUsage: {
        toolCalls: 0,
        tokens: 0,
        costUsd: 0,
      },
    };
  }
};
