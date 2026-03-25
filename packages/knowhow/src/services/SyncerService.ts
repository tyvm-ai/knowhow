/**
 * SyncerService - Unified wrapper around AgentSyncFs and AgentSyncKnowhowWeb
 * Hides complexity of choosing and managing sync backends.
 */
import { BaseAgent } from "../agents/base/base";
import { AgentSyncFs } from "./AgentSyncFs";
import { AgentSyncKnowhowWeb } from "./AgentSyncKnowhowWeb";

export interface SyncerOptions {
  taskId: string;
  prompt: string;
  /** If provided → use web sync (unless syncFs is set) */
  messageId?: string;
  /** Force fs sync even if messageId is provided */
  syncFs?: boolean;
  /** Use an existing Knowhow task ID instead of creating a new one */
  existingKnowhowTaskId?: string;
  /** Agent name to persist in metadata.json */
  agentName?: string;
}

export interface AgentSyncer {
  /** Set up sync for a new task. Returns the sync task ID */
  createTask(options: SyncerOptions): Promise<string>;
  /** Wire up event listeners on the agent */
  setupAgentSync(agent: BaseAgent, taskId: string): Promise<void>;
  /** Wait for all pending sync operations to complete */
  waitForFinalization(): Promise<void>;
  /** Reset state for next task */
  reset(): void;
  /** Whether this syncer is active (has been configured) */
  isActive(): boolean;
}

/**
 * SyncerService implements AgentSyncer by delegating to AgentSyncFs and/or AgentSyncKnowhowWeb.
 *
 * Decision logic:
 *   - Always sets up AgentSyncFs (primary local syncer)
 *   - If messageId is present AND syncFs is not forced AND no existingKnowhowTaskId → also sets up AgentSyncKnowhowWeb
 */
export class SyncerService implements AgentSyncer {
  private fsSync: AgentSyncFs;
  private webSync: AgentSyncKnowhowWeb;
  private active: boolean = false;
  private useWebSync: boolean = false;
  private createdTaskId: string | undefined;

  constructor() {
    this.fsSync = new AgentSyncFs();
    this.webSync = new AgentSyncKnowhowWeb();
  }

  /**
   * Create sync task(s) and return the primary task ID.
   * The returned ID is the local (fs) task ID.
   */
  async createTask(options: SyncerOptions): Promise<string> {
    this.active = true;
    this.useWebSync = false;

    // Determine whether to use web sync
    const shouldUseWebSync =
      !!options.messageId &&
      !options.syncFs &&
      !options.existingKnowhowTaskId;

    // Always create fs sync task first
    console.log(
      `📁 Using filesystem-based synchronization for task: ${options.taskId}`
    );
    const fsTaskId = await this.fsSync.createTask({
      taskId: options.taskId,
      prompt: options.prompt,
      agentName: options.agentName,
    });

    // Optionally create web sync task
    if (shouldUseWebSync) {
      const knowhowTaskId = await this.webSync.createChatTask({
        messageId: options.messageId,
        prompt: options.prompt,
      });

      if (knowhowTaskId) {
        this.useWebSync = true;
        this.createdTaskId = knowhowTaskId;
        console.log(`🌐 Web sync task created: ${knowhowTaskId}`);
      }
    }

    return fsTaskId;
  }

  /**
   * Wire up event listeners for all active sync backends.
   * @param agent - the agent to sync
   * @param taskId - the fs task ID (returned by createTask)
   */
  async setupAgentSync(agent: BaseAgent, taskId: string): Promise<void> {
    await this.fsSync.setupAgentSync(agent, taskId);

    if (this.useWebSync && this.createdTaskId) {
      await this.webSync.setupAgentSync(agent, this.createdTaskId);
    }
  }

  /**
   * Wait for finalization across all active sync backends.
   */
  async waitForFinalization(): Promise<void> {
    if (this.useWebSync) {
      console.log("🎯 [SyncerService] Waiting for web sync finalization...");
      await this.webSync.waitForFinalization();
      console.log("🎯 [SyncerService] Web sync finalization complete");
    }

    console.log("🎯 [SyncerService] Waiting for fs sync finalization...");
    await this.fsSync.waitForFinalization();
    console.log("🎯 [SyncerService] Fs sync finalization complete");
  }

  /**
   * Reset both sync backends for the next task.
   */
  reset(): void {
    this.webSync.reset();
    this.fsSync.reset();
    this.active = false;
    this.useWebSync = false;
    this.createdTaskId = undefined;
  }

  /**
   * Whether this syncer has been configured for a task.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Returns the Knowhow web task ID if one was created (for updating TaskInfo).
   */
  getCreatedWebTaskId(): string | undefined {
    return this.useWebSync ? this.createdTaskId : undefined;
  }
}
