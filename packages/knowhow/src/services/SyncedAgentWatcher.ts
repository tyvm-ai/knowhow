/**
 * SyncedAgentWatcher - Watch agents running in other processes or on knowhow-web
 * and display their messages in real-time through the renderer.
 */

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { AgentRenderer } from "../chat/renderer/types";
import { messagesToRenderEvents } from "../chat/renderer/messagesToRenderEvents";
import { KnowhowSimpleClient } from "./KnowhowClient";

export interface SyncedAgentWatcher {
  /** Start watching for changes, emitting render events */
  startWatching(taskId: string, renderer: AgentRenderer): Promise<void>;
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
  private renderer: AgentRenderer | null = null;
  private lastThreadLength: number = 0;
  public agentName: string = "unknown";
  private debounceTimer: NodeJS.Timeout | null = null;

  async startWatching(taskId: string, renderer: AgentRenderer): Promise<void> {
    this.taskId = taskId;
    this.taskPath = path.join(".knowhow/processes/agents", taskId);
    this.renderer = renderer;

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
    console.log(`   Type /logs 20 to see recent messages, or type to send a message`);
  }

  private async onMetadataChanged(): Promise<void> {
    if (!this.renderer) return;
    const metadata = await this.readMetadata();
    if (!metadata?.threads) return;

    const threads: any[][] = metadata.threads;
    const lastThread = threads[threads.length - 1] || [];

    // Only render NEW messages since last check
    const newMessages = lastThread.slice(this.lastThreadLength);
    if (newMessages.length === 0) return;

    const events = messagesToRenderEvents(newMessages, this.taskId, this.agentName);
    for (const event of events) {
      this.renderer.render(event);
    }
    this.lastThreadLength = lastThread.length;
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
  private renderer: AgentRenderer | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastThreadLength: number = 0;
  public agentName: string = "remote-agent";
  private stopped: boolean = false;

  constructor(client?: KnowhowSimpleClient) {
    this.client = client || new KnowhowSimpleClient();
  }

  async startWatching(taskId: string, renderer: AgentRenderer): Promise<void> {
    this.taskId = taskId;
    this.renderer = renderer;
    this.stopped = false;

    // Load initial state to track current thread length
    try {
      const details = await this.client.getTaskDetails(taskId);
      const threads: any[][] = details?.data?.threads || [];
      const lastThread = threads[threads.length - 1] || [];
      this.agentName = "remote-agent";
      this.lastThreadLength = lastThread.length;
    } catch (err: any) {
      console.warn(`⚠️  Could not load initial state for task ${taskId}: ${err.message}`);
    }

    // Poll every 3 seconds for updates
    this.pollInterval = setInterval(async () => {
      if (!this.stopped) {
        await this.onPoll().catch(() => {});
      }
    }, 3000);

    console.log(`🌐 Watching web-synced agent: ${taskId} (${this.agentName})`);
    console.log(`   Type /logs 20 to see recent messages, or type to send a message`);
  }

  private async onPoll(): Promise<void> {
    if (!this.renderer || this.stopped) return;
    try {
      const details = await this.client.getTaskDetails(this.taskId);
      const threads: any[][] = details?.data?.threads || [];
      const lastThread = threads[threads.length - 1] || [];

      const newMessages = lastThread.slice(this.lastThreadLength);
      if (newMessages.length > 0) {
        const events = messagesToRenderEvents(newMessages, this.taskId, this.agentName);
        for (const event of events) {
          this.renderer.render(event);
        }
        this.lastThreadLength = lastThread.length;
      }

      // Stop polling if task is complete
      const status = details?.data?.status;
      if (status === "completed" || status === "killed") {
        console.log(`\n✅ Remote agent ${this.taskId} status: ${status}`);
        this.stopWatching();
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
}
