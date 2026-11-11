/**
 * Manual: does each provider accept a conversation that ENDS with tool results
 * (no trailing user message)?  [system, user, assistant(tool_call), tool(result)]
 *
 * Backs the decision to stop nagging after every tool turn in base.ts.
 *   npx jest -c jest.manual.config.js tests/manual/clients/tool-result-tail.test.ts --testTimeout=90000 --runInBand
 */
import { AIClient } from "../../../src/clients";
import { Message, Tool } from "../../../src/clients/types";

const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "getSecretNumber",
      description: "Returns the secret number",
      parameters: { type: "object", properties: {}, required: [] },
    },
  } as Tool,
];

const messages: Message[] = [
  { role: "system", content: "You are terse. Use tools when needed." },
  { role: "user", content: "What is the secret number? Use the tool." },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "getSecretNumber", arguments: "{}" },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", name: "getSecretNumber", content: "42" },
];

const matrix: [string, string, string][] = [
  ["openai", "gpt-4.1-mini-2025-04-14", "OPENAI_API_KEY"],
  ["anthropic", "claude-haiku-4-5-20251001", "ANTHROPIC_API_KEY"],
  ["google", "gemini-2.5-flash", "GEMINI_API_KEY"],
  ["xai", "grok-4-1-fast-reasoning", "XAI_API_KEY"],
];

describe("conversation ending in tool results", () => {
  const client = new AIClient();
  for (const [provider, model, envKey] of matrix) {
    const run = process.env[envKey] ? it : it.skip;
    run(`${provider} (${model}) completes normally`, async () => {
      const res = await client.createCompletion(provider, {
        model,
        messages: JSON.parse(JSON.stringify(messages)),
        tools,
        max_tokens: 200,
      });
      const msg = res.choices[0].message;
      console.log(provider, JSON.stringify(msg.content), msg.tool_calls?.length);
      expect(res.choices.length).toBeGreaterThan(0);
      expect(msg.content || msg.tool_calls?.length).toBeTruthy();
    });
  }
});
