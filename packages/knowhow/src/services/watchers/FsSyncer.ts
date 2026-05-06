import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

import { SyncedAgentWatcher } from "../SyncedAgentWatcher";
import { messagesToRenderEvents } from "../../chat/renderer/messagesToRenderEvents";
import { EventService } from "../EventService";

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
