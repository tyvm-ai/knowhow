/**
 * SyncedAgentWatcher - Watch agents running in other processes or on knowhow-web
 * and emit agent events as messages come in, decoupled from rendering.
 */

import { Message } from "../clients/types";
import { EventService } from "./EventService";

export interface SyncedAgentWatcher {
  /** Start watching for changes, emitting agent events */
  startWatching(taskId: string): Promise<void>;
  /** Stop watching */
  stopWatching(): void;
  /** The task ID being watched */
  taskId: string;
  /** The agent name being watched */
  agentName: string;
  /** Send a message to the remote agent */
  sendMessage(message: string): Promise<void>;
  /** Get current threads (for replaying history via /logs) */
  getThreads(): Promise<any[][]>;
  /** EventService that emits agent lifecycle events (toolCall, toolUsed, agentSay, threadUpdate, done) */
  agentEvents: EventService;
  /** Event type constants mirroring BaseAgent.eventTypes */
  eventTypes: {
    done: string;
    toolCall: string;
    toolUsed: string;
    agentSay: string;
    threadUpdate: string;
  };
  /** Pause the remote agent */
  pause(): Promise<void>;
  /** Unpause/resume the remote agent */
  unpause(): Promise<void>;
  /** Kill/terminate the remote agent */
  kill(): Promise<void>;
}

/**
 * A minimal agent-like interface used by attachedAgentChatLoop.
 * Both BaseAgent and WatcherBackedAgent implement this, allowing the
 * single attachedAgentChatLoop to handle both local and remote agents.
 */
export interface AttachableAgent {
  name: string;
  agentEvents: EventService;
  eventTypes: {
    done: string;
    toolCall?: string;
    toolUsed?: string;
    agentSay?: string;
  };
  getTotalCostUsd(): number;
  pause(): void | Promise<void>;
  unpause(): void | Promise<void>;
  kill(): void | Promise<void>;
  addPendingUserMessage(message: Message): void;
}

/**
 * Adapts a SyncedAgentWatcher to the AttachableAgent interface so that
 * attachedAgentChatLoop can drive both local agents and remote/watcher-backed
 * agents through a single code path.
 *
 * - pause/unpause/kill delegate to the watcher
 * - addPendingUserMessage calls watcher.sendMessage()
 * - agentEvents and eventTypes are delegated to the watcher
 * - "done" is emitted by the watcher when the remote agent completes
 */
export class WatcherBackedAgent implements AttachableAgent {
  public name: string;
  public agentEvents: EventService;
  public eventTypes: { done: string };

  constructor(public readonly watcher: SyncedAgentWatcher) {
    this.name = watcher.agentName;
    this.agentEvents = watcher.agentEvents;
    this.eventTypes = watcher.eventTypes;
  }

  getTotalCostUsd(): number {
    return 0;
  }

  async pause(): Promise<void> {
    await this.watcher.pause();
  }

  async unpause(): Promise<void> {
    await this.watcher.unpause();
  }

  async kill(): Promise<void> {
    await this.watcher.kill();
    // Signal the chat loop to exit
    this.agentEvents.emit(this.eventTypes.done, "Agent killed");
  }

  addPendingUserMessage(message: Message): void {
    // Fire-and-forget — errors are logged but not surfaced
    const text = typeof message.content === "string" ? message.content : "";
    this.watcher
      .sendMessage(text)
      .then(() => {
        console.log(`📨 Message sent to ${this.name}`);
      })
      .catch((err) => {
        console.error(`❌ Failed to send message to ${this.name}:`, err);
      });
  }
}
