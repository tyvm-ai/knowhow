/**
 * SyncedAgentWatcher - Watch agents running in other processes or on knowhow-web
 * and emit agent events as messages come in, decoupled from rendering.
 */

import { Message } from "../clients/types";
import { EventService } from "./EventService";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { messagesToRenderEvents } from "../chat/renderer/messagesToRenderEvents";
import { KnowhowSimpleClient } from "./KnowhowClient";

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
  eventTypes: { done: string; toolCall: string; toolUsed: string; agentSay: string; threadUpdate: string };
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
  eventTypes: { done: string; toolCall?: string; toolUsed?: string; agentSay?: string };
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

/**
 * Watches an agent running in another process via the filesystem.
 * Reads .knowhow/processes/agents/<taskId>/metadata.json for changes.
 * Sends messages by writing to .knowhow/processes/agents/<taskId>/input.txt
 */
export class FsSyncedAgentWatcher implements SyncedAgentWatcher {
  public taskId: string = "";
  private taskPath: string = "";
  private watcher: fs.FSWatcher | null = null;
  private lastThreadLength: number = 0;
  public agentName: string = "unknown";
  private debounceTimer: NodeJS.Timeout | null = null;
  public agentEvents = new EventService();
  public eventTypes = {
    done: "done",
    toolCall: "tool:pre_call",
    toolUsed: "tool:post_call",
    agentSay: "agent:say",
    threadUpdate: "thread_update",
  };

  async startWatching(taskId: string): Promise<void> {
    this.taskId = taskId;
    this.taskPath = path.join(".knowhow/processes/agents", taskId);

    // Load initial state to track current thread length (for delta rendering)
    const metadata = await this.readMetadata();
    if (metadata) {
      const threads: any[][] = metadata.threads || [];
      const lastThread = threads[threads.length - 1] || [];
      this.agentName = metadata.agentName || taskId;
      this.lastThreadLength = lastThread.length;
    }

    // Watch the directory for metadata.json changes
    try {
      this.watcher = fs.watch(this.taskPath, (event, filename) => {
        if (filename === "metadata.json" || filename === null) {
          // Debounce rapid file writes
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.onMetadataChanged().catch(() => {});
          }, 200);
        }
      });
    } catch (err: any) {
      console.warn(`⚠️  Could not watch ${this.taskPath}: ${err.message}`);
    }

    console.log(`👁️  Watching fs-synced agent: ${taskId} (${this.agentName})`);
    console.log(
      `   Type /logs 20 to see recent messages, or type to send a message`
    );
  }

  private async onMetadataChanged(): Promise<void> {
    const metadata = await this.readMetadata();
    if (!metadata?.threads) return;

    const threads: any[][] = metadata.threads;
    const lastThread = threads[threads.length - 1] || [];

    // Only render NEW messages since last check
    const newMessages = lastThread.slice(this.lastThreadLength);
    if (newMessages.length > 0) {
      const renderEvents = messagesToRenderEvents(
        newMessages,
        this.taskId,
        this.agentName
      );
      for (const event of renderEvents) {
        if (event.type === "toolCall") {
          this.agentEvents.emit(this.eventTypes.toolCall, {
            toolCall: (event as any).toolCall,
          });
        } else if (event.type === "toolResult") {
          this.agentEvents.emit(this.eventTypes.toolUsed, {
            toolCall: (event as any).toolCall,
            functionResp: (event as any).result,
          });
        } else if (event.type === "agentMessage") {
          this.agentEvents.emit(this.eventTypes.agentSay, {
            message: (event as any).message,
          });
        }
      }
      this.agentEvents.emit(this.eventTypes.threadUpdate, lastThread);
      this.lastThreadLength = lastThread.length;
    }

    // Emit done if the agent has completed and has a result
    const status = metadata.status;
    const result = metadata.result;
    if ((status === "completed" || status === "killed") && result != null) {
      this.stopWatching();
      this.agentEvents.emit(this.eventTypes.done, result);
    }
  }

  async sendMessage(message: string): Promise<void> {
    const inputPath = path.join(this.taskPath, "input.txt");
    await fsPromises.writeFile(inputPath, message, "utf8");
  }

  async getThreads(): Promise<any[][]> {
    const metadata = await this.readMetadata();
    return metadata?.threads || [];
  }

  stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    console.log(`🔌 Stopped watching agent: ${this.taskId}`);
  }

  async pause(): Promise<void> {
    const statusPath = path.join(this.taskPath, "status.txt");
    await fsPromises.writeFile(statusPath, "paused", "utf8");
    console.log(`⏸️  Paused remote agent: ${this.taskId}`);
  }

  async unpause(): Promise<void> {
    const statusPath = path.join(this.taskPath, "status.txt");
    await fsPromises.writeFile(statusPath, "running", "utf8");
    console.log(`▶️  Unpaused remote agent: ${this.taskId}`);
  }

  async kill(): Promise<void> {
    const statusPath = path.join(this.taskPath, "status.txt");
    await fsPromises.writeFile(statusPath, "killed", "utf8");
    console.log(`🛑 Killed remote agent: ${this.taskId}`);
  }

  private async readMetadata(): Promise<any> {
    try {
      const metaPath = path.join(this.taskPath, "metadata.json");
      const content = await fsPromises.readFile(metaPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

/**
 * Watches an agent running on Knowhow Web via polling the API.
 * Polls GET /tasks/<taskId> every 3 seconds for thread updates.
 * Sends messages via the client's sendMessageToAgent method.
 */
export class WebSyncedAgentWatcher implements SyncedAgentWatcher {
  public taskId: string = "";
  private client: KnowhowSimpleClient;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastThreadLength: number = 0;
  public agentName: string = "remote-agent";
  private stopped: boolean = false;
  public agentEvents = new EventService();
  public eventTypes = {
    done: "done",
    toolCall: "tool:pre_call",
    toolUsed: "tool:post_call",
    agentSay: "agent:say",
    threadUpdate: "thread_update",
  };

  constructor(client?: KnowhowSimpleClient) {
    this.client = client || new KnowhowSimpleClient();
  }

  async startWatching(taskId: string): Promise<void> {
    this.taskId = taskId;
    this.stopped = false;

    // Load initial state to track current thread length
    try {
      const details = await this.client.getTaskDetails(taskId);
      const threads: any[][] = details?.data?.threads || [];
      const lastThread = threads[threads.length - 1] || [];
      this.agentName = "remote-agent";
      this.lastThreadLength = lastThread.length;
    } catch (err: any) {
      console.warn(
        `⚠️  Could not load initial state for task ${taskId}: ${err.message}`
      );
    }

    // Poll every 3 seconds for updates
    this.pollInterval = setInterval(async () => {
      if (!this.stopped) {
        await this.onPoll().catch(() => {});
      }
    }, 3000);

    console.log(`🌐 Watching web-synced agent: ${taskId} (${this.agentName})`);
    console.log(
      `   Type /logs 20 to see recent messages, or type to send a message`
    );
  }

  private async onPoll(): Promise<void> {
    if (this.stopped) return;
    try {
      const details = await this.client.getTaskDetails(this.taskId);
      const threads: any[][] = details?.data?.threads || [];
      const lastThread = threads[threads.length - 1] || [];

      const newMessages = lastThread.slice(this.lastThreadLength);
      if (newMessages.length > 0) {
        const renderEvents = messagesToRenderEvents(
          newMessages,
          this.taskId,
          this.agentName
        );
        for (const event of renderEvents) {
          if (event.type === "toolCall") {
            this.agentEvents.emit(this.eventTypes.toolCall, {
              toolCall: (event as any).toolCall,
            });
          } else if (event.type === "toolResult") {
            this.agentEvents.emit(this.eventTypes.toolUsed, {
              toolCall: (event as any).toolCall,
              functionResp: (event as any).result,
            });
          } else if (event.type === "agentMessage") {
            this.agentEvents.emit(this.eventTypes.agentSay, {
              message: (event as any).message,
            });
          }
        }
        this.agentEvents.emit(this.eventTypes.threadUpdate, lastThread);
        this.lastThreadLength = lastThread.length;
      }

      // Stop polling and emit done if task is complete with a result
      const status = details?.data?.status;
      const result = details?.data?.result;
      if (status === "completed" || status === "killed") {
        this.stopWatching();
        if (result != null) {
          this.agentEvents.emit(this.eventTypes.done, result);
        } else {
          console.log(`\n✅ Remote agent ${this.taskId} status: ${status} (no result)`);
        }
      }
    } catch {
      // Silently continue on poll errors
    }
  }

  async sendMessage(message: string): Promise<void> {
    await this.client.sendMessageToAgent(this.taskId, message);
  }

  async getThreads(): Promise<any[][]> {
    try {
      const details = await this.client.getTaskDetails(this.taskId);
      return details?.data?.threads || [];
    } catch {
      return [];
    }
  }

  stopWatching(): void {
    this.stopped = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log(`🔌 Stopped watching web agent: ${this.taskId}`);
  }

  async pause(): Promise<void> {
    await this.client.pauseAgent(this.taskId);
    console.log(`⏸️  Paused remote web agent: ${this.taskId}`);
  }

  async unpause(): Promise<void> {
    await this.client.resumeAgent(this.taskId);
    console.log(`▶️  Unpaused remote web agent: ${this.taskId}`);
  }

  async kill(): Promise<void> {
    await this.client.killAgent(this.taskId);
    console.log(`🛑 Killed remote web agent: ${this.taskId}`);
  }
}
