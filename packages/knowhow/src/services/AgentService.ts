import { getConfigSync } from "../config";
import { IAgent } from "../agents/interface";
import { EventService } from "./EventService";
import { ToolsService } from "./Tools";
import { ConfigAgent } from "../agents/configurable/ConfigAgent";
import { TraceAll } from "../util/Trace";
import { AgentContext } from "../agents/base/base";

@TraceAll()
export class AgentService {
  private agents: Map<string, IAgent> = new Map();
  private agentContext: AgentContext | null = null;

  constructor(private tools: ToolsService, private events: EventService) {
    this.wireUp();
  }

  public wireUp() {
    this.tools.addTool({
      type: "function",
      function: {
        name: "agentCall",
        description: `Allows an agent to ask another agent a question. Useful for getting help from agents that are configured for specific goals.
        ${this.getAgentDescriptions()}`,
        parameters: {
          type: "object",
          positional: true,
          properties: {
            agentName: {
              type: "string",
              description: `The name of the agent to call. Available agents: ${this.listAgents()}`,
            },
            query: {
              type: "string",
              description: `The query to send to the agent`,
            },
          },
          required: ["agentName", "query"],
        },
      },
    });
    this.events.on("agents:register", (data) => {
      console.log(`Agent registered: ${data.name}`);
      const { name, agent } = data;
      this.registerAgentByName(name, agent);
    });

    this.events.on("agents:call", (data) => {
      console.log(`Agent called: ${data.name}`);
      const { name, query, resolve, reject } = data;
      this.callAgent(name, query).then(resolve).catch(reject);
    });
  }

  public registerAgent(agent: IAgent): void {
    this.registerAgentByName(agent.name, agent);
  }

  public registerAgentByName(name: string, agent: IAgent): void {
    this.agents.set(name, agent);
  }

  /**
   * Set the AgentContext that will be used when creating new agent instances.
   * Should be called from cli.ts after all services are wired up (including LazyToolsService).
   */
  public setAgentContext(context: AgentContext): void {
    this.agentContext = context;
  }

  /**
   * Get the current AgentContext. Falls back to a minimal context using this service's
   * own tools/events if none has been explicitly set.
   */
  public getAgentContext(): AgentContext {
    return this.agentContext ?? { Tools: this.tools, Events: this.events };
  }

  public getAgent<T extends IAgent = IAgent>(name: string): T {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(
        `Agent ${name} not found. Options are: ${this.listAgents()}`
      );
    }
    return agent as T;
  }

  public listAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  public getAgentDescriptions() {
    return Object.keys(this.agents).map((key) => {
      const agent = this.getAgent(key);
      return `name: ${agent.name} \n description: ${agent.description}`;
    });
  }

  public loadAgentsFromConfig(context: AgentContext) {
    const config = getConfigSync();
    const agents = config.agents || [];

    for (const agent of agents) {
      this.registerAgent(new ConfigAgent(agent, context));
    }
  }

  /**
   * Run a registered agent and return both its final answer and the cost it
   * incurred. Returning cost (from the agent's own `getTotalCostUsd()`) lets
   * callers — notably the script sandbox — account subagent spend against a
   * budget. The `answer` string preserves the previous plain-string behavior
   * for consumers that only care about the response.
   */
  public async callAgent(
    name: string,
    query: string
  ): Promise<{ answer: string; costUsd: number }> {
    const agent = this.agents.get(name);
    if (!agent) {
      return {
        answer: `Agent ${name} not found. Options are: ${this.listAgents()}`,
        costUsd: 0,
      };
    }
    const answer = await agent.call(query);
    const costUsd =
      typeof (agent as any).getTotalCostUsd === "function"
        ? (agent as any).getTotalCostUsd()
        : 0;
    return { answer, costUsd };
  }
}
