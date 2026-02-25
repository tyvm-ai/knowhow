/**
 * Agent Synchronization Service - Handles synchronization with Knowhow API
 * including task creation, updates, and message processing
 */
import {
  KnowhowSimpleClient,
  KNOWHOW_API_URL,
  TaskDetailsResponse,
  PendingMessage,
} from "./KnowhowClient";
import { BaseAgent } from "../agents/base/base";
import { wait } from "../utils";

export interface SyncOptions {
  messageId?: string;
  existingKnowhowTaskId?: string;
  prompt: string;
}

export interface TaskSyncState {
  knowhowTaskId?: string;
  client: KnowhowSimpleClient;
  messageId?: string;
}

/**
 * AgentSynchronization handles all communication with the Knowhow API
 * for task creation, updates, status polling, and message synchronization
 */
export class AgentSyncKnowhowWeb {
  private client: KnowhowSimpleClient;
  private baseUrl: string;
  private knowhowTaskId: string | undefined;
  private eventHandlersSetup: boolean = false;
  private finalizationPromise: Promise<void> | null = null;

  constructor(baseUrl: string = KNOWHOW_API_URL) {
    this.baseUrl = baseUrl;
    this.client = new KnowhowSimpleClient(baseUrl);
  }

  /**
   * Create a new chat task in Knowhow
   */
  async createChatTask(options: SyncOptions): Promise<string | undefined> {
    if (!options.messageId || !this.baseUrl) {
      return undefined;
    }

    try {
      console.log(
        `Base URL for Knowhow API: ${this.baseUrl}, Message ID: ${options.messageId}`
      );
      const response = await this.client.createChatTask({
        messageId: options.messageId,
        prompt: options.prompt,
      });
      const knowhowTaskId = response.data.id;
      console.log(`✅ Created Knowhow chat task: ${knowhowTaskId}`);
      return knowhowTaskId;
    } catch (error) {
      console.error(`❌ Failed to create Knowhow chat task:`, error);
      return undefined;
    }
  }

  /**
   * Update a chat task with current agent state
   */
  async updateChatTask(
    knowhowTaskId: string,
    agent: BaseAgent,
    inProgress: boolean,
    result?: string
  ): Promise<void> {
    if (!knowhowTaskId || !this.baseUrl) {
      return;
    }

    try {
      await this.client.updateChatTask(knowhowTaskId, {
        threads: agent.getThreads(),
        totalCostUsd: agent.getTotalCostUsd(),
        inProgress,
        ...(result ? { result } : {}),
      });
      console.log(`✅ Updated Knowhow chat task: ${knowhowTaskId}`);
    } catch (error) {
      console.error(`❌ Failed to update Knowhow chat task:`, error);
    }
  }

  /**
   * Check for pending messages and process them, also handle pause/kill status
   */
  async checkAndProcessPendingMessages(
    agent: BaseAgent,
    knowhowTaskId: string
  ): Promise<void> {
    if (!knowhowTaskId || !this.baseUrl) {
      return;
    }

    try {
      // Fetch task details to check status
      const taskDetailsResponse = await this.client.getTaskDetails(
        knowhowTaskId
      );
      const taskDetails: TaskDetailsResponse = taskDetailsResponse.data;

      // Handle killed status
      if (taskDetails.status === "killed") {
        console.log(`🛑 Agent task ${knowhowTaskId} was killed via API`);
        await agent.kill();
        return;
      }

      // Handle paused status
      if (taskDetails.status === "paused") {
        console.log(
          `⏸️ Agent task ${knowhowTaskId} is paused, waiting for resume...`
        );
        await agent.pause();
        await this.waitForResume(agent, knowhowTaskId);
        return; // After resume, we'll process messages on the next threadUpdate
      }

      // Fetch pending messages
      const pendingResponse = await this.client.getPendingMessages(
        knowhowTaskId
      );
      const pendingMessages: PendingMessage[] = pendingResponse.data || [];

      if (pendingMessages.length === 0) {
        return; // No pending messages to process
      }

      console.log(
        `📬 Processing ${pendingMessages.length} pending message(s) for task ${knowhowTaskId}`
      );

      // Inject pending messages into the agent
      const messageIds: string[] = [];
      for (const msg of pendingMessages) {
        agent.addPendingUserMessage({
          role: msg.role as "user" | "assistant",
          content: msg.message,
        });
        messageIds.push(msg.id);
      }

      // Mark messages as processed
      await this.client.markMessagesAsProcessed(knowhowTaskId, messageIds);
      console.log(`✅ Marked ${messageIds.length} message(s) as processed`);
    } catch (error) {
      console.error(`❌ Error checking/processing pending messages:`, error);
      // Continue execution even if synchronization fails
    }
  }

  /**
   * Wait for the agent to be resumed or killed via API
   * Polls the API every 2 seconds, with a 1 hour timeout
   */
  private async waitForResume(
    agent: BaseAgent,
    knowhowTaskId: string
  ): Promise<void> {
    const POLL_INTERVAL_MS = 2000;
    const MAX_WAIT_MS = 60 * 60 * 1000; // 1 hour
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      try {
        const taskDetailsResponse = await this.client.getTaskDetails(
          knowhowTaskId
        );
        const taskDetails: TaskDetailsResponse = taskDetailsResponse.data;

        if (taskDetails.status === "killed") {
          console.log(`🛑 Agent task ${knowhowTaskId} was killed while paused`);
          await agent.kill();
          return;
        }

        if (
          taskDetails.status === "running" ||
          taskDetails.status === "completed"
        ) {
          console.log(`▶️ Agent task ${knowhowTaskId} resumed`);
          await agent.unpause();
          return;
        }
        // Still paused, continue waiting
      } catch (error) {
        console.error(`❌ Error polling task status:`, error);
        // Continue polling even on errors
      }
    }

    console.warn(`⚠️ Timeout waiting for resume on task ${knowhowTaskId}`);
  }

  /**
   * Set up event-based synchronization for an agent task
   * This sets up event listeners that automatically sync on threadUpdate and completion
   */
  async setupAgentSync(
    agent: BaseAgent,
    knowhowTaskId?: string
  ): Promise<void> {
    if (!knowhowTaskId || !this.baseUrl) {
      return;
    }

    this.knowhowTaskId = knowhowTaskId;

    // Set up event listeners for automatic synchronization
    if (!this.eventHandlersSetup) {
      this.setupEventHandlers(agent);
      this.eventHandlersSetup = true;
    }
  }

  /**
   * Set up event handlers for automatic synchronization
   */
  private setupEventHandlers(agent: BaseAgent): void {
    // Listen to thread updates to sync state and check for pending messages
    agent.agentEvents.on(agent.eventTypes.threadUpdate, async () => {
      if (!this.knowhowTaskId || !this.baseUrl) {
        return;
      }

      try {
        // Update task with current state
        await this.updateChatTask(this.knowhowTaskId, agent, true);

        // Check for pending messages, pause, or kill status
        await this.checkAndProcessPendingMessages(agent, this.knowhowTaskId);
      } catch (error) {
        console.error(`❌ Error during threadUpdate sync:`, error);
        // Continue execution even if synchronization fails
      }
    });

    // Listen to completion event to finalize task
    agent.agentEvents.on(agent.eventTypes.done, async (result: string) => {
      if (!this.knowhowTaskId || !this.baseUrl) {
        console.warn(`⚠️ [AgentSync] Cannot finalize: knowhowTaskId=${this.knowhowTaskId}, baseUrl=${this.baseUrl}`);
        return;
      }

      console.log(`🎯 [AgentSync] Done event received for task: ${this.knowhowTaskId}`);

      // Create a promise that tracks finalization
      this.finalizationPromise = (async () => {
        try {
          console.log(
            `Updating Knowhow chat task on completion..., ${this.knowhowTaskId}`
          );
          await this.updateChatTask(this.knowhowTaskId!, agent, false, result);
          console.log(`✅ Completed Knowhow chat task: ${this.knowhowTaskId}`);
        } catch (error) {
          console.error(`❌ Error finalizing task:`, error);
          throw error; // Re-throw so CLI can handle it
        }
      })();
    });
  }

  /**
   * Wait for finalization to complete (for CLI usage)
   */
  async waitForFinalization(): Promise<void> {
    if (this.finalizationPromise) {
      await this.finalizationPromise;
    }
  }

  /**
   * Reset synchronization state (useful for reusing the service)
   */
  reset(): void {
    this.knowhowTaskId = undefined;
    this.eventHandlersSetup = false;
    this.finalizationPromise = null;
  }

  /**
   * Finalize an agent task on completion
   */
  async finalizeTask(
    agent: BaseAgent,
    knowhowTaskId: string | undefined,
    result: string
  ): Promise<void> {
    if (knowhowTaskId && this.baseUrl) {
      console.log(
        `Updating Knowhow chat task on completion..., ${knowhowTaskId}`
      );
      await this.updateChatTask(knowhowTaskId, agent, false, result);
      console.log(`✅ Completed Knowhow chat task: ${knowhowTaskId}`);
    }
  }
}
