import { EventEmitter } from "events";
import { IAgent } from "../agents/interface";

export interface EventHandler {
  handler: (...args: any[]) => any;
}

export class EventService extends EventEmitter {
  private blockingHandlers: Map<string, EventHandler[]> = new Map();

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

    // Also register with the regular EventEmitter for compatibility
    this.on(event, handler);
  }

  /**
   * Emit a blocking event - if any blocking handler throws, execution stops
   * @param event The event name
   * @param args Arguments to pass to handlers
   * @returns Promise that resolves when all handlers complete, or rejects if any blocking handler throws
   */
  async emitBlocking(event: string, ...args: any[]): Promise<void> {
    const handlers = this.blockingHandlers.get(event) || [];

    for (const { handler } of handlers) {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        // If this is a blocking handler and it throws, stop execution
        throw error;
      }
    }

    this.emit(event, ...args);
  }

  /**
   * Emit a non-blocking event - all handlers run, errors are logged but don't stop execution
   * @param event The event name
   * @param args Arguments to pass to handlers
   */
  emitNonBlocking(event: string, ...args: any[]): void {
    const handlers = this.blockingHandlers.get(event) || [];

    handlers.forEach(async ({ handler }) => {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        console.warn(`Event handler for '${event}' threw an error:`, error);
      }
    });

    this.emit(event, ...args);
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
