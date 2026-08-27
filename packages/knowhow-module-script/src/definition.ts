import { Tool } from "@tyvm/knowhow/ts_build/src/clients";

/**
 * Tool for executing TypeScript scripts in a secure sandbox
 */
export const executeScriptDefinition: Tool = {
  type: "function",
  function: {
    name: "executeScript",
    description: `Used to construct a script that calls tools and analyzes data, not for general purpose scripting.

    This is most useful for complex workflows of tool calls that need conditional logic based off tool responses.

  The script has access to:
  - scriptArgs: Read-only JSON arguments supplied by the caller
  - callTool(toolName, parameters): Call any available tool
  - llm(messages, options): Make LLM calls
  - agent(agentName, query): Run another registered agent as a node (it can use tools/loop/keep context) and get its final answer string back. Great for graph-based agents. Compose with Promise.all for concurrent agent nodes.
  - createArtifact(name, content, type): Create downloadable artifacts
  - console: Standard console logging
  - getQuotaUsage(): Check resource usage
  - sleep(ms): Pause execution for a specified time, max 2000ms
  - Generic tool functions: any available tool can also be called directly by its name as a top-level function, e.g. \`textSearch({ searchTerm: 'x' })\` is shorthand for \`callTool('textSearch', { searchTerm: 'x' })\`. Reserved globals (callTool, llm, agent, sleep, console, etc.) are never shadowed.
  - Multi-agent orchestration tools (via callTool or as generic functions): startAgentTask (spawn a subagent, returns a taskId), waitForAgentCompleted (join a subagent -> { status, costUsd, finalAnswer }), sendAgentMessage (send a message/poke to a running agent), connectAgent (wire agents together with an ARRAY of { listener, speaker } connections for bidirectional/pipeline/star/mesh topologies), stopConnections, replyToParent, observe/stopObserving.

  The script cannot:
    - import or require
    - make external network requests, outside of callTool and llm

  Example:
  \`\`\`typescript
  // Read a caller-provided argument, with a default
  const maxCycles = scriptArgs.maxCycles ?? 4;

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

  Security: Scripts run in isolation. Resource limits are optional and have no defaults; only set one when the run has a known, intentional cap.`,

    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "The TypeScript code to execute. 4000 tokens or less",
        },
        args: {
          type: "object",
          description:
            "Optional JSON-serializable object exposed inside the sandbox as the read-only scriptArgs global.",
        },
        maxToolCalls: {
          type: "number",
          description:
            "Optional tool-call limit. No default; omit when the required number of calls is not known.",
        },
        maxTokens: {
          type: "number",
          description:
            "Optional LLM token limit. No default; only set for an intentionally bounded run.",
        },
        maxExecutionTimeMs: {
          type: "number",
          description:
            "Optional wall-clock deadline in milliseconds. No default; only set when a known completion deadline exists.",
        },
        maxCostUsd: {
          type: "number",
          description:
            "Optional cost limit in USD. No default; only set for an intentionally bounded run.",
        },
      },
      required: ["script"],
    },
  },
};
