import { EventEmitter } from "events";
import { IAgent } from "../agents/interface";

export type EventHandlerFn = (...args: any[]) => any;

export interface EventHandler {
  handler: EventHandlerFn;
}

export interface ManagedListenerSpec {
  key: string;
  event: string;
  once?: boolean;
  blocking?: boolean;
}

export interface AgentLogEvent {
  agentName: string;
  message: string;
  level: "info" | "warn" | "error";
  timestamp: number;
  taskId?: string | null;
}

type ManagedListenerRecord = {
  key: string;
  event: string;
  handler: EventHandlerFn;
  wrappedHandler: EventHandlerFn;
  once: boolean;
  blocking: boolean;
};

export class EventService extends EventEmitter {
  private blockingHandlers: Map<string, EventHandler[]> = new Map();
  private managedListeners: Map<string, ManagedListenerRecord> = new Map();

  eventTypes = {
    agentMsg: "agent:msg",
    agentsRegister: "agents:register",
    agentsCall: "agents:call",
    pluginLog: "plugin:log",
  };

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Register a blocking handler.
   * These run during emitBlocking / emitNonBlocking before normal EventEmitter listeners.
   */
  onBlocking(event: string, handler: EventHandlerFn): void {
    if (!this.blockingHandlers.has(event)) {
      this.blockingHandlers.set(event, []);
    }

    this.blockingHandlers.get(event)!.push({ handler });
  }

  /**
   * Remove a blocking handler.
   */
  offBlocking(event: string, handler: EventHandlerFn): void {
    const handlers = this.blockingHandlers.get(event);
    if (!handlers) return;

    const filtered = handlers.filter((entry) => entry.handler !== handler);

    if (filtered.length === 0) {
      this.blockingHandlers.delete(event);
      return;
    }

    this.blockingHandlers.set(event, filtered);
  }

  /**
   * Set a managed listener.
   *
   * Semantics:
   * - key is unique
   * - if a listener already exists for this key, it is removed first
   * - supports normal or blocking listeners
   * - supports once semantics
   */
  setListener(spec: ManagedListenerSpec, handler: EventHandlerFn): void {
    const { key, event, once = false, blocking = false } = spec;

    this.removeManagedListener(key);

    let wrappedHandler: EventHandlerFn;

    if (once) {
      wrappedHandler = (...args: any[]) => {
        try {
          handler(...args);
        } finally {
          this.managedListeners.delete(key);
        }
      };
    } else {
      wrappedHandler = handler;
    }

    const record: ManagedListenerRecord = {
      key,
      event,
      handler,
      wrappedHandler,
      once,
      blocking,
    };

    if (blocking) {
      if (!this.blockingHandlers.has(event)) {
        this.blockingHandlers.set(event, []);
      }

      this.blockingHandlers.get(event)!.push({ handler: wrappedHandler });
    } else {
      if (once) {
        super.once(event, wrappedHandler);
      } else {
        super.on(event, wrappedHandler);
      }
    }

    this.managedListeners.set(key, record);
  }

  /**
   * Remove a managed listener by key.
   */
  removeManagedListener(key: string): void {
    const existing = this.managedListeners.get(key);
    if (!existing) return;

    if (existing.blocking) {
      this.offBlocking(existing.event, existing.wrappedHandler);
    } else {
      super.removeListener(existing.event, existing.wrappedHandler);
    }

    this.managedListeners.delete(key);
  }

  /**
   * Remove all managed listeners whose key starts with the given prefix.
   */
  removeManagedListenersByPrefix(prefix: string): void {
    for (const key of Array.from(this.managedListeners.keys())) {
      if (key.startsWith(prefix)) {
        this.removeManagedListener(key);
      }
    }
  }

  /**
   * Remove all managed listeners registered through setListener.
   */
  clearManagedListeners(): void {
    for (const key of Array.from(this.managedListeners.keys())) {
      this.removeManagedListener(key);
    }
  }

  /**
   * Check whether a managed listener exists for the given key.
   */
  hasManagedListener(key: string): boolean {
    return this.managedListeners.has(key);
  }

  /**
   * Emit a blocking event - if any blocking handler throws, execution stops.
   * After blocking handlers succeed, normal EventEmitter listeners are emitted.
   */
  async emitBlocking(event: string, ...args: any[]): Promise<any[]> {
    const results: any[] = [];
    const handlers = this.blockingHandlers.get(event) || [];

    for (const { handler } of handlers) {
      try {
        const result = handler(...args);
        results.push(result instanceof Promise ? await result : result);
      } catch (error) {
        throw error;
      }
    }

    this.emit(event, ...args);
    return results.filter((r) => Boolean(r));
  }

  /**
   * Emit a non-blocking event - blocking handlers still run first,
   * but their errors are logged instead of thrown.
   * Then normal EventEmitter listeners are emitted.
   */
  async emitNonBlocking(event: string, ...args: any[]): Promise<any[]> {
    const handlers = this.blockingHandlers.get(event) || [];
    const results: any[] = [];

    for (const { handler } of handlers) {
      try {
        const result = handler(...args);
        results.push(result instanceof Promise ? await result : result);
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

  log(
    source: string,
    message: string,
    level: "info" | "warn" | "error" = "info"
  ): void {
    this.emit(this.eventTypes.pluginLog, {
      source,
      message,
      level,
      timestamp: Date.now(),
    });
  }
}
