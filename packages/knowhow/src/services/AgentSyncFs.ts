/**
 * Agent Synchronization Service - Filesystem-based synchronization
 * Handles synchronization via filesystem files in .knowhow/processes/agents/taskId/
 */
import { BaseAgent } from "../agents/base/base";
import { promises as fs } from "fs";
import * as path from "path";
import { watch } from "fs";

export interface FsSyncOptions {
  taskId: string;
  prompt: string;
}

/**
 * AgentSyncFs handles filesystem-based synchronization for agent tasks
 * Creates files in .knowhow/processes/agents/{taskId}/ for status and input
 */
export class AgentSyncFs {
  private taskId: string | undefined;
  private basePath: string = ".knowhow/processes/agents";
  private taskPath: string | undefined;
  private eventHandlersSetup: boolean = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private lastInputContent: string = "";
  private cleanupInterval: NodeJS.Timeout | null = null;
  private finalizationPromise: Promise<void> | null = null;

  constructor() {
    // Start cleanup process when created
    this.startCleanupProcess();
  }

  /**
   * Create filesystem sync for a task
   */
  async createTask(options: FsSyncOptions): Promise<string> {
    this.taskId = options.taskId;
    this.taskPath = path.join(this.basePath, this.taskId);

    try {
      // Create directory structure
      await fs.mkdir(this.taskPath, { recursive: true });

      // Create initial files
      await this.writeStatus("running");
      await this.writeInput("");
      await this.writeMetadata({
        taskId: this.taskId,
        prompt: options.prompt,
        startTime: new Date().toISOString(),
        status: "running",
      });

      console.log(`✅ Created filesystem sync at: ${this.taskPath}`);
      return this.taskId;
    } catch (error) {
      console.error(`❌ Failed to create filesystem sync:`, error);
      throw error;
    }
  }

  /**
   * Update task status
   */
  private async writeStatus(status: string): Promise<void> {
    if (!this.taskPath) return;

    try {
      const statusPath = path.join(this.taskPath, "status.txt");
      await fs.writeFile(statusPath, status, "utf8");
    } catch (error) {
      console.error(`❌ Failed to write status:`, error);
    }
  }

  /**
   * Write input file (used for initial state)
   */
  private async writeInput(content: string): Promise<void> {
    if (!this.taskPath) return;

    try {
      const inputPath = path.join(this.taskPath, "input.txt");
      await fs.writeFile(inputPath, content, "utf8");
      this.lastInputContent = content;
    } catch (error) {
      console.error(`❌ Failed to write input:`, error);
    }
  }

  /**
   * Write metadata file
   */
  private async writeMetadata(data: any): Promise<void> {
    if (!this.taskPath) return;

    try {
      const metadataPath = path.join(this.taskPath, "metadata.json");
      await fs.writeFile(metadataPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.error(`❌ Failed to write metadata:`, error);
    }
  }

  /**
   * Update metadata file with current agent state
   */
  private async updateMetadata(agent: BaseAgent, inProgress: boolean, result?: string): Promise<void> {
    if (!this.taskPath) return;

    try {
      const metadataPath = path.join(this.taskPath, "metadata.json");
      let metadata: any = {};

      try {
        const existingData = await fs.readFile(metadataPath, "utf8");
        metadata = JSON.parse(existingData);
      } catch {
        // File doesn't exist or is invalid, start fresh
      }

      metadata.threads = agent.getThreads();
      metadata.totalCostUsd = agent.getTotalCostUsd();
      metadata.inProgress = inProgress;
      metadata.lastUpdate = new Date().toISOString();

      if (result !== undefined) {
        metadata.result = result;
        metadata.status = "completed";
        await this.writeStatus("completed");
      }

      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    } catch (error) {
      console.error(`❌ Failed to update metadata:`, error);
    }
  }

  /**
   * Read and process status file changes
   */
  private async readStatus(): Promise<string | null> {
    if (!this.taskPath) return null;

    try {
      const statusPath = path.join(this.taskPath, "status.txt");
      const content = await fs.readFile(statusPath, "utf8");
      return content.trim();
    } catch (error) {
      // File might not exist or be accessible
      return null;
    }
  }

  /**
   * Read and process input file changes
   */
  private async readInput(): Promise<string | null> {
    if (!this.taskPath) return null;

    try {
      const inputPath = path.join(this.taskPath, "input.txt");
      const content = await fs.readFile(inputPath, "utf8");
      return content;
    } catch (error) {
      // File might not exist or be accessible
      return null;
    }
  }

  /**
   * Check for file changes and process them
   */
  private async checkForChanges(agent: BaseAgent): Promise<void> {
    if (!this.taskPath) return;

    try {
      // Check status changes
      const status = await this.readStatus();
      if (status === "paused") {
        console.log(`⏸️ Agent task ${this.taskId} paused via filesystem`);
        await agent.pause();
        await this.waitForResume(agent);
      } else if (status === "killed") {
        console.log(`🛑 Agent task ${this.taskId} killed via filesystem`);
        await agent.kill();
      }

      // Check for new input/messages
      const input = await this.readInput();
      if (input && input !== this.lastInputContent && input.trim() !== "") {
        console.log(`📬 New message received via filesystem for task ${this.taskId}`);
        this.lastInputContent = input;

        agent.addPendingUserMessage({
          role: "user",
          content: input,
        });

        // Clear the input file after processing
        await this.writeInput("");
      }
    } catch (error) {
      console.error(`❌ Error checking for changes:`, error);
    }
  }

  /**
   * Wait for resume by monitoring status file
   */
  private async waitForResume(agent: BaseAgent): Promise<void> {
    const POLL_INTERVAL_MS = 2000;
    const MAX_WAIT_MS = 60 * 60 * 1000; // 1 hour
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const status = await this.readStatus();
      
      if (status === "killed") {
        console.log(`🛑 Agent task ${this.taskId} killed while paused`);
        await agent.kill();
        return;
      }

      if (status === "running") {
        console.log(`▶️ Agent task ${this.taskId} resumed`);
        await agent.unpause();
        return;
      }
    }

    console.warn(`⚠️ Timeout waiting for resume on task ${this.taskId}`);
  }

  /**
   * Setup filesystem watching for the task
   */
  private setupFileWatcher(agent: BaseAgent): void {
    if (!this.taskPath || this.watcher) return;

    try {
      this.watcher = watch(this.taskPath, async (eventType, filename) => {
        if (filename === "status.txt" || filename === "input.txt") {
          await this.checkForChanges(agent);
        }
      });

      console.log(`👁️ Watching filesystem at: ${this.taskPath}`);
    } catch (error) {
      console.error(`❌ Failed to setup file watcher:`, error);
    }
  }

  /**
   * Set up event-based synchronization for an agent task
   */
  async setupAgentSync(agent: BaseAgent, taskId?: string): Promise<void> {
    if (!taskId) return;

    this.taskId = taskId;
    this.taskPath = path.join(this.basePath, this.taskId);

    // Ensure directory exists (might have been created by createTask)
    try {
      await fs.mkdir(this.taskPath, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    if (!this.eventHandlersSetup) {
      this.setupEventHandlers(agent);
      this.setupFileWatcher(agent);
      this.eventHandlersSetup = true;
    }
  }

  /**
   * Set up event handlers for automatic synchronization
   */
  private setupEventHandlers(agent: BaseAgent): void {
    // Listen to thread updates to sync state
    agent.agentEvents.on(agent.eventTypes.threadUpdate, async () => {
      if (!this.taskId) return;

      try {
        await this.updateMetadata(agent, true);
        await this.checkForChanges(agent);
      } catch (error) {
        console.error(`❌ Error during threadUpdate sync:`, error);
      }
    });

    // Listen to completion event to finalize task
    agent.agentEvents.on(agent.eventTypes.done, (result: string) => {
      if (!this.taskId) {
        console.warn(`⚠️ [AgentSyncFs] Cannot finalize: taskId=${this.taskId}`);
        return;
      }

      console.log(`🎯 [AgentSyncFs] Done event received for task: ${this.taskId}`);

      // Store finalization promise so callers can await it (same pattern as AgentSyncKnowhowWeb)
      this.finalizationPromise = (async () => {
        try {
          await this.updateMetadata(agent, false, result);
          console.log(`✅ Completed filesystem sync for task: ${this.taskId}`);
          await this.cleanup();
        } catch (error) {
          console.error(`❌ Error finalizing task:`, error);
          throw error;
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
   * Cleanup task directory and watcher
   */
  async cleanup(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Note: We don't delete the directory here to preserve task history
    // The cleanup process will handle old directories
  }

  /**
   * Clean up old task directories (older than 3 days)
   */
  private async cleanupOldTasks(): Promise<void> {
    try {
      const agentsPath = this.basePath;
      
      // Check if directory exists
      try {
        await fs.access(agentsPath);
      } catch {
        // Directory doesn't exist, nothing to clean
        return;
      }

      const entries = await fs.readdir(agentsPath, { withFileTypes: true });
      const now = Date.now();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const taskPath = path.join(agentsPath, entry.name);
        
        try {
          const stats = await fs.stat(taskPath);
          const age = now - stats.mtimeMs;

          if (age > threeDaysMs) {
            console.log(`🧹 Cleaning up old task directory: ${entry.name}`);
            await fs.rm(taskPath, { recursive: true, force: true });
          }
        } catch (error) {
          // Skip if we can't stat or delete
          console.error(`❌ Error cleaning up ${entry.name}:`, error);
        }
      }
    } catch (error) {
      console.error(`❌ Error during cleanup:`, error);
    }
  }

  /**
   * Start periodic cleanup process
   */
  private startCleanupProcess(): void {
    // Run cleanup every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldTasks();
    }, 60 * 60 * 1000);

    // Also run once on startup
    this.cleanupOldTasks();
  }

  /**
   * Stop cleanup process
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Reset synchronization state
   */
  reset(): void {
    this.cleanup();
    this.taskId = undefined;
    this.taskPath = undefined;
    this.eventHandlersSetup = false;
    this.lastInputContent = "";
    this.finalizationPromise = null;
  }
}
