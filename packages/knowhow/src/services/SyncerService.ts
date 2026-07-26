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
  /**
   * Push the agent's work to a remote Knowhow task. When set (and there is no
   * messageId), the `taskId` is treated as the remote task ID to attach to and
   * push updates to, rather than creating a new remote task.
   */
  syncRemote?: boolean;
  /** Agent name to persist in metadata.json */
  agentName?: string;
  /** The taskId of the parent agent that spawned this task, if any. */
  parentTaskId?: string;
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
 *   - If messageId is present AND syncFs is not forced → creates a new remote task via AgentSyncKnowhowWeb
 *   - If syncRemote is set (and no messageId) → attaches to the remote task identified by taskId
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

    // Determine whether to CREATE a new remote (web) task: only when we have a
    // messageId and aren't forcing fs-only. A messageId means "definitely
    // remote" — create a fresh remote task from that message.
    const shouldUseWebSync =
      !!options.messageId &&
      !options.syncFs;

    // Determine whether to ATTACH to an already-existing remote task and push
    // local work to it (no creation needed). This is the "--sync-remote" path:
    // the caller wants to push work to the remote task identified by taskId.
    // We only auto-attach when there is NO messageId (messageId always creates
    // a fresh remote task above).
    //
    // This is orthogonal to fs sync: we can push to the remote task AND keep
    // the local .knowhow/processes/agents/<id>/ files in sync at the same time.
    const shouldAttachExisting =
      !!options.syncRemote && !options.messageId && !!options.taskId;

    // Always create fs sync task first
    console.log(
      `📁 Using filesystem-based synchronization for task: ${options.taskId}`
    );
    const fsTaskId = await this.fsSync.createTask({
      taskId: options.taskId,
      prompt: options.prompt,
      agentName: options.agentName,
      parentTaskId: options.parentTaskId,
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

    // Attach live web sync to an existing remote task (push updates to it).
    if (!shouldUseWebSync && shouldAttachExisting) {
      this.useWebSync = true;
      this.createdTaskId = options.taskId;
      console.log(
        `🌐 Attaching web sync to existing remote task: ${options.taskId}`
      );
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
