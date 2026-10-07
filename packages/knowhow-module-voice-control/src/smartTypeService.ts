/**
 * Injectable AI service for smarttype / agenttype commands.
 *
 * `runVoiceAgent` builds it with buildSmartTypeAi() after setupServices() and
 * puts it on the services container (`services.ai`); the smart-type pack reads
 * `ctx.services.ai`.
 */

export interface SmartTypeAi {
  /** Run a one-shot LLM completion and return the text. */
  complete(system: string, user: string): Promise<string>;
  /** Run a full agent and return its final answer. `onTool` reports tool calls as they start. */
  runAgent(prompt: string, opts?: { onTool?: (name: string) => void }): Promise<string>;
}

export interface SmartTypeServices {
  ai: SmartTypeAi;
  agentName?: string;
}

/**
 * Build a SmartTypeAi from the knowhow Clients and AgentService.
 * provider/model are read from config or env.
 */
export function buildSmartTypeAi(
  Clients: {
    createCompletion(provider: string, opts: {
      model?: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
    }): Promise<{ choices: Array<{ message: { content?: string | null } }> }>;
  },
  Agents: {
    callAgent(name: string, query: string): Promise<{ answer: string; costUsd: number }>;
    startInteractive?(name: string, options: { initialInput: any; signal?: AbortSignal }): Promise<{
      events(signal?: AbortSignal): AsyncIterable<any>;
      done: Promise<{ answer: string; costUsd: number }>;
    }>;
  },
  agentName: string,
  provider = "anthropic",
  model = "claude-sonnet-4-6",
): SmartTypeAi {
  return {
    async complete(system: string, user: string): Promise<string> {
      const response = await Clients.createCompletion(provider, {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 1024,
      });
      return response.choices[0]?.message?.content ?? "";
    },

    async runAgent(prompt: string, opts?: { onTool?: (name: string) => void }): Promise<string> {
      let answer: string;
      if (typeof Agents.startInteractive === "function") {
        // Same path as "hey knowhow": interactive task on the voice agent, with
        // the default message processors (screenshots etc. stay in budget).
        const handle = await Agents.startInteractive(agentName, {
          initialInput: {
            id: `agenttype-${Date.now()}`,
            kind: "user",
            content: prompt,
            timestamp: Date.now(),
            metadata: { activation: "agenttype" },
          },
        });
        void (async () => {
          try {
            for await (const ev of handle.events()) {
              if (ev?.type === "tool.started") opts?.onTool?.(ev.name);
            }
          } catch {
            // event stream is informational only
          }
        })();
        ({ answer } = await handle.done);
      } else {
        ({ answer } = await Agents.callAgent(agentName, prompt));
      }
      // Strip ``` fences if the whole answer is a single fenced block
      return stripFences(answer);
    },
  };
}

/** Strip leading/trailing ``` fences if the answer is a single fenced block. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)```\s*$/);
  if (m) return m[1].trimEnd();
  return trimmed;
}
