import { EventEmitter } from "events";
import { IAgent } from "../agents/interface";

export interface EventHandler {
  handler: (...args: any[]) => any;
}

export class EventService extends EventEmitter {
  private blockingHandlers: Map<string, EventHandler[]> = new Map();

  eventTypes = {
    agentMsg: "agent:msg",
    agentsRegister: "agents:register",
    agentsCall: "agents:call",
  };

  constructor() {
    super();
  }

  /**
   * Register an event handler as blocking or non-blocking
   * @param event The event name
   * @param handler The event handler function
   * @param isBlocking Whether this handler should be blocking
   */
  onBlocking(event: string, handler: (...args: any[]) => any): void {
    if (!this.blockingHandlers.has(event)) {
      this.blockingHandlers.set(event, []);
    }

    this.blockingHandlers.get(event)!.push({ handler });
  }

  /**
   * Emit a blocking event - if any blocking handler throws, execution stops
   * @param event The event name
   * @param args Arguments to pass to handlers
   * @returns Promise that resolves with array of handler results when all handlers complete, or rejects if any blocking handler throws
   */
  async emitBlocking(event: string, ...args: any[]): Promise<any[]> {
    const results: any[] = [];

    const handlers = this.blockingHandlers.get(event) || [];

    for (const { handler } of handlers) {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          const awaitedResult = await result;
          results.push(awaitedResult);
        } else {
          results.push(result);
        }
      } catch (error) {
        // If this is a blocking handler and it throws, stop execution
        throw error;
      }
    }

    this.emit(event, ...args);
    return results.filter((r) => Boolean(r));
  }

  /**
   * Emit a non-blocking event - all handlers run, errors are logged but don't stop execution
   * @param event The event name
   * @param args Arguments to pass to handlers
   * @returns Promise that resolves with array of handler results when all handlers complete
   */
  async emitNonBlocking(event: string, ...args: any[]): Promise<any[]> {
    const handlers = this.blockingHandlers.get(event) || [];
    const results: any[] = [];
    for (const { handler } of handlers) {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          const awaitedResult = await result;
          results.push(awaitedResult);
        } else {
          results.push(result);
        }
      } catch (error) {
        console.error(
          `Non-blocking handler error for event '${event}':`,
          error
        );
      }
    }

    this.emit(event, ...args);
    return results.filter((r) => Boolean(r));
  }

  registerAgent(agent: IAgent): void {
    this.emit(this.eventTypes.agentsRegister, { name: agent.name, agent });
  }

  callAgent(name: string, query: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.emit(this.eventTypes.agentsCall, { name, query, resolve, reject });
    });
  }
}
