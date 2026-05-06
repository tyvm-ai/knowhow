import { Message } from "../../clients/types";
import { EventService } from "../EventService";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { messagesToRenderEvents } from "../../chat/renderer/messagesToRenderEvents";
import { KnowhowSimpleClient } from "../KnowhowClient";
import { SyncedAgentWatcher } from "../SyncedAgentWatcher";

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
          console.log(
            `\n✅ Remote agent ${this.taskId} status: ${status} (no result)`
          );
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
