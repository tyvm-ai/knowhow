import { AgentContext, BaseAgent } from "../base/base";
import { Message } from "../../clients/types";
import { Assistant, Config } from "../../types";
import { MessageProcessor } from "../../services/MessageProcessor";

export class ConfigAgent extends BaseAgent {
  name: string;
  description: string;

  constructor(private config: Assistant, context: AgentContext) {
    super(context);
    this.name = config.name;
    this.setModelPreferences([
      { model: config.model, provider: config.provider },
    ]);
  }

  async getInitialMessages(userInput: string) {
    return [
      { role: "system", content: this.config.instructions },
      { role: "user", content: userInput },
    ] as Message[];
  }
}
