import { getConfigSync } from "../config";
import { IAgent } from "../agents/interface";
import { EventService } from "./EventService";
import { ToolsService } from "./Tools";
import { ConfigAgent } from "../agents/configurable/ConfigAgent";
import { AgentContext } from "../agents/base/base";

export class AgentService {
  private agents: Map<string, IAgent> = new Map();

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

  public getAgent(name: string): IAgent {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(
        `Agent ${name} not found. Options are: ${this.listAgents()}`
      );
    }
    return agent;
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

  public async callAgent(name: string, query: string): Promise<string> {
    const agent = this.agents.get(name);
    if (!agent) {
      return `Agent ${name} not found. Options are: ${this.listAgents()}`;
    }
    return agent.call(query);
  }
}
