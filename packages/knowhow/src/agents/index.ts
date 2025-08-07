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

let singletons = {} as {
  Developer: DeveloperAgent;
  Patcher: PatchingAgent;
  Researcher: ResearcherAgent;
  Setup: SetupAgent;
};

export function agents(agentContext: AgentContext = services()) {
  if (Object.keys(singletons).length === 0) {
    singletons = {
      Developer: new DeveloperAgent(agentContext),
      Patcher: new PatchingAgent(agentContext),
      Researcher: new ResearcherAgent(agentContext),
      Setup: new SetupAgent(agentContext),
    };
  }
  return singletons;
}
