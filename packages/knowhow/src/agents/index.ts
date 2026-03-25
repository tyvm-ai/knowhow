import { services } from "../services";
import { AgentContext } from "./base/base";
import { DeveloperAgent } from "./developer/developer";
import { PatchingAgent } from "./patcher/patcher";
import { ResearcherAgent } from "./researcher/researcher";
import { SetupAgent } from "./setup/setup";

export { BaseAgent } from "./base/base";
export { ConfigAgent } from "./configurable/ConfigAgent";
export { DeveloperAgent };
export { PatchingAgent };
export { AgentContext };

export * from "./researcher/researcher";

export * as tools from "./tools";
export { includedTools } from "./tools/list";

export type AgentName = "Developer" | "Patcher" | "Researcher" | "Setup";

/**
 * Registry of agent constructors (not instances).
 * Use createAgent() to get a fresh instance per task, avoiding stale event listener issues.
 */
export const agentConstructors: Record<AgentName, new (context: AgentContext) => any> = {
  Developer: DeveloperAgent,
  Patcher: PatchingAgent,
  Researcher: ResearcherAgent,
  Setup: SetupAgent,
};

/**
 * Create a fresh agent instance by name.
 * Always returns a new instance to avoid shared state / stale listeners between tasks.
 */
export function createAgent(agentName: AgentName, agentContext: AgentContext = services()) {
  const AgentClass = agentConstructors[agentName];
  if (!AgentClass) {
    throw new Error(`Agent "${agentName}" not found. Available agents: ${Object.keys(agentConstructors).join(", ")}`);
  }
  return new AgentClass(agentContext);
}

/** @deprecated Use createAgent() for per-task instances to avoid event listener leaks */
export function agents(agentContext: AgentContext = services()) {
  return {
    Developer: new DeveloperAgent(agentContext),
    Patcher: new PatchingAgent(agentContext),
    Researcher: new ResearcherAgent(agentContext),
    Setup: new SetupAgent(agentContext),
  };
}
