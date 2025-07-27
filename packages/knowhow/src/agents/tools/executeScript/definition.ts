import { Tool } from "../../../clients";

/**
 * Tool for executing TypeScript scripts in a secure sandbox
 */
export const executeScriptDefinition: Tool = {
  type: "function",
  function: {
    name: "executeScript",
    description: `Used to contruct a script that calls tools and analyzes data, not for general purpose scripting.

    This is most useful for complex workflows of tool calls that need conditional logic based off tool responses.

  The script has access to:
  - callTool(toolName, parameters): Call any available tool
  - llm(messages, options): Make LLM calls
  - createArtifact(name, content, type): Create downloadable artifacts
  - console: Standard console logging
  - getQuotaUsage(): Check resource usage
  - sleep(ms): Pause execution for a specified time, max 2000ms

  The script cannot:
    - import or require
    - make external network requests, outside of callTool and llm

  Example:
  \`\`\`typescript
  // Call a tool
  const searchResult = await callTool('textSearch', { searchTerm: 'hello world' });
  console.log('Search found:', searchResult);

  // Call LLM
  const response = await llm([
    { role: 'user', content: 'Explain quantum computing' }
  ], { model: 'gpt-4o-mini', maxTokens: 100 });
  console.log('LLM response:', response.choices[0].message.content);

  // Create an artifact
  createArtifact('summary.md', '# Summary\\nThis is a test', 'markdown');

  return { message: 'Script completed successfully' };
  \`\`\`

  You must return the data you want to be the functionResp

  Test tools yourself to know the return type when scripting. Can pass JSON.stringified data into llm call if you don't need to know the type.
  You cannot use isolation breaking methods like: setTimeout setInterval setImmediate clearTimeout clearInterval

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
