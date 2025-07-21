import { EventEmitter } from "events";
import { IAgent } from "../agents/interface";

export class EventService extends EventEmitter {
  constructor() {
    super();
  }

  registerAgent(agent: IAgent): void {
    this.emit("agents:register", { name: agent.name, agent });
  }

  callAgent(name: string, query: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.emit("agents:call", { name, query, resolve, reject });
    });
  }
}
