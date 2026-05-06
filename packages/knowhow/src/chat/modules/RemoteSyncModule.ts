/**
 * RemoteSyncModule - Handles /sync:remote, /sync:remote:off, /sync:status commands
 * Allows CLI users to push agent tasks to the remote KnowHow web app.
 */
import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatContext, ChatService } from "../types";
import {
  KnowhowSimpleClient,
  KNOWHOW_API_URL,
} from "../../services/KnowhowClient";
import { AgentSyncKnowhowWeb } from "../../services/AgentSyncKnowhowWeb";
import { AgentModule } from "./AgentModule";
import { TaskInfo } from "../types";
import { getConfig, updateConfig } from "../../config";

export class RemoteSyncModule extends BaseChatModule {
  name = "remote-sync";
  description = "Remote sync functionality (/sync:remote, /sync:status)";

  /** Per-process remote session ID - created once, reused for all tasks in this terminal */
  private remoteSessionId: string | undefined;

  /** Worker ID from config (set when running as a worker) */
  private workerId: string | undefined;

  /** Whether remote auto-sync is enabled for new tasks */
  private autoSync: boolean = false;

  /** Count of messages synced in this terminal session */
  private syncedMessageCount: number = 0;

  /** Reference to AgentModule for accessing task registry */
  private agentModule: AgentModule;

  /** KnowHow API client */
  private client: KnowhowSimpleClient;

  constructor(agentModule: AgentModule) {
    super();
    this.agentModule = agentModule;
    this.client = new KnowhowSimpleClient(KNOWHOW_API_URL);
  }

  /**
   * On initialize, read config to set initial autoSync state.
   */
  async initialize(service: ChatService): Promise<void> {
    await super.initialize(service);
    const config = await getConfig();
    if (config.syncRemote === true) {
      this.autoSync = true;
      console.log("📡 Remote auto-sync enabled (from config syncRemote: true)");
    }
    if (config.worker?.workerId) {
      this.workerId = config.worker.workerId;
      console.log(`🔗 Worker ID loaded: ${this.workerId}`);
    }
  }

  getCommands(): ChatCommand[] {
    return [
      {
        name: "sync:remote",
        description:
          "Push the current agent task to the remote KnowHow app. Creates a remote session+message if needed.",
        handler: this.handleSyncRemote.bind(this),
      },
      {
        name: "share",
        description: "Alias for /sync:remote",
        handler: this.handleSyncRemote.bind(this),
      },
      {
        name: "sync:remote:on",
        description: "Enable remote auto-sync for all future agent tasks and save to config",
        handler: this.handleSyncRemoteOn.bind(this),
      },
      {
        name: "sync:remote:off",
        description: "Disable auto remote sync for future tasks",
        handler: this.handleSyncRemoteOff.bind(this),
      },
      {
        name: "sync:status",
        description: "Show current remote sync state",
        handler: this.handleSyncStatus.bind(this),
      },
    ];
  }

  /**
   * Get the active task: first checks context for activeAgentTaskId,
   * then falls back to the most recently registered task.
   */
  private getActiveTask(
    taskIdArg?: string
  ): { taskId: string; taskInfo: TaskInfo } | undefined {
    const registry = this.agentModule.getTaskRegistry();
    const context = this.chatService?.getContext();

    // If explicit taskId provided, look it up
    if (taskIdArg) {
      const taskInfo = registry.get(taskIdArg);
      if (taskInfo) return { taskId: taskIdArg, taskInfo };
      console.log(`⚠️  Task "${taskIdArg}" not found in registry.`);
      return undefined;
    }

    // Use context's activeAgentTaskId
    const activeId = context?.activeAgentTaskId;
    if (activeId) {
      const taskInfo = registry.get(activeId);
      if (taskInfo) return { taskId: activeId, taskInfo };
    }

    // Fall back to most recently registered task
    const allTasks = registry.getEntries();
    if (allTasks.length > 0) {
      const [taskId, taskInfo] = allTasks[allTasks.length - 1];
      return { taskId, taskInfo };
    }

    return undefined;
  }

  /**
   * Extract a remote session UUID from a URL or raw UUID string.
   * e.g. "http://localhost:3000/chat/47838f91-e918-4f77-9122-0160531f7d2a"
   *      or "47838f91-e918-4f77-9122-0160531f7d2a"
   */
  private extractSessionId(input: string): string | undefined {
    // Match a UUID pattern (8-4-4-4-12 hex chars)
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const match = input.match(uuidRegex);
    if (match) {
      return match[0];
    }
    return undefined;
  }

  /**
   * Ensure we have a remote session for this terminal process.
   * On first call, creates a new session. Subsequent calls reuse it.
   */
  private async ensureRemoteSession(
    title: string,
    prompt: string
  ): Promise<string> {
    if (this.remoteSessionId) {
      console.log(
        `📡 Using existing remote session: ${this.remoteSessionId}`
      );
      return this.remoteSessionId;
    }

    console.log("📡 Creating remote session for this terminal session...");
    const result = await this.client.createSessionPlaceholder({
      title: title.slice(0, 80) || "CLI Session",
      workerId: this.workerId,
      metadata: { source: "cli", createdAt: new Date().toISOString() },
    });

    this.remoteSessionId = result.sessionId;
    console.log(`✅ Remote session created: ${result.sessionId}`);
    return result.sessionId;
  }

  /**
   * Create a remote message placeholder for the given task prompt.
   */
  private async createRemoteMessagePlaceholder(
    sessionId: string,
    prompt: string,
    agentName?: string,
    modelName?: string
  ): Promise<{ messageId: string; taskId: string | undefined }> {
    const result = await this.client.createMessagePlaceholder(sessionId, {
      content: prompt,
      agentName,
      modelName,
      metadata: { source: "cli", createdAt: new Date().toISOString() },
    });
    return { messageId: result.messageId, taskId: result.taskId };
  }

  /**
   * Handle /sync:remote [taskId]
   */
  private async handleSyncRemote(args: string[]): Promise<void> {
    const argRaw = args[0];

    // Check if the arg is a remote session ID (UUID) or a URL containing one
    if (argRaw) {
      const sessionId = this.extractSessionId(argRaw);
      if (sessionId) {
        // User passed a remote session URL/ID — use that session for future syncs
        this.remoteSessionId = sessionId;
        console.log(`📡 Using remote session: ${sessionId}`);
        console.log(
          "   Future agent interactions will be appended to this session.\n" +
            "   Use /sync:remote:off to disable, or /sync:remote:on to persist to config."
        );
        // Enable auto-sync for this session too
        if (!this.autoSync) {
          this.autoSync = true;
        }
        // If there's an active task, sync it to this session now
        const taskEntry = this.getActiveTask(undefined);
        if (taskEntry) {
          await this.syncTask(taskEntry.taskId);
        }
        return;
      }
    }

    const taskIdArg = argRaw;
    const taskEntry = this.getActiveTask(taskIdArg);

    if (!taskEntry) {
      // No task yet — enable auto-sync for future interactions (session-only, no config write)
      this.autoSync = true;
      console.log(
        "📡 Remote auto-sync enabled for this session.\n" +
          "   Future agent interactions will be pushed to the remote KnowHow app.\n" +
          "   Use /sync:remote:off to disable, or /sync:remote:on to persist to config."
      );
      return;
    }

    await this.syncTask(taskEntry.taskId);

    // Also enable auto-sync for future interactions in this session
    if (!this.autoSync) {
      this.autoSync = true;
      console.log(
        "📡 Remote auto-sync enabled for future agent tasks this session.\n" +
          "   Use /sync:remote:on to persist this setting, or /sync:remote:off to disable."
      );
    }
  }

  /**
   * Sync a specific task by taskId to the remote KnowHow app.
   * Called by AgentModule for auto-sync, or directly by handleSyncRemote.
   */
  public async syncTask(taskId: string): Promise<void> {
    const registry = this.agentModule.getTaskRegistry();
    const taskInfo = registry.get(taskId);

    // Refresh JWT in case it was updated since client was instantiated (e.g. after knowhow login)
    this.client.refreshJwt();

    if (!taskInfo) {
      console.log(
        `⚠️  Task "${taskId}" not found in registry.`
      );
      return;
    }

    // Check if already synced
    if (taskInfo.knowhowTaskId && taskInfo.chatSessionId) {
      console.log(
        `ℹ️  Task "${taskId}" is already synced to remote session ${taskInfo.chatSessionId}.\n` +
          `   Remote task ID: ${taskInfo.knowhowTaskId}\n` +
          `   Use /sync:status to see full sync state.`
      );
      return;
    }

    try {
      // Step 1: Ensure remote session exists
      console.log("\n🔐 Checking KnowHow API credentials...");
      const me = await this.client.me();
      console.log(`✅ Authenticated as ${me.data?.email || "unknown"}`);

      const title =
        taskInfo.initialInput?.slice(0, 80) || `CLI Session – ${new Date().toLocaleString()}`;
      const sessionId = await this.ensureRemoteSession(
        title,
        taskInfo.initialInput
      );

      // Step 2: Create remote message placeholder
      console.log(
        `\n📨 Creating remote message for task: ${taskId}`
      );
      const agentName = taskInfo.agentName;
      const modelName = taskInfo.agent?.getModel();
      const { messageId, taskId: placeholderTaskId } = await this.createRemoteMessagePlaceholder(
        sessionId,
        taskInfo.formattedPrompt || taskInfo.initialInput,
        agentName,
        modelName
      );
      console.log(`✅ Remote message created: ${messageId}`);

      // Step 3: Use the task stub created by createMessagePlaceholder (avoids creating a second OrgAgentTask)
      const knowhowTaskId = placeholderTaskId;
      if (!knowhowTaskId) {
        console.log(
          "❌ Failed to create remote agent task. Aborting sync."
        );
        return;
      }
      console.log(`\n🔗 Using task from message placeholder: ${knowhowTaskId}`);
      const webSync = new AgentSyncKnowhowWeb(KNOWHOW_API_URL);
      console.log(`✅ Remote task created: ${knowhowTaskId}`);

      // Step 4: Update local task info with remote IDs
      taskInfo.knowhowMessageId = messageId;
      taskInfo.knowhowTaskId = knowhowTaskId;
      taskInfo.chatSessionId = sessionId;

      // Update session manager
      const sessionManager = this.agentModule.getSessionManager();
      sessionManager.updateSession(taskId, taskInfo, taskInfo.agent?.getThreads() || []);

      // Step 5: Wire up live sync
      console.log(`\n🚀 Syncing thread progress to remote...`);
      const agent = taskInfo.agent;
      if (agent) {
        if (taskInfo.status === "completed" || taskInfo.status === "failed") {
          // Task already done — push final state directly
          await webSync.setupAgentSync(agent, knowhowTaskId);
          await webSync.updateChatTask(knowhowTaskId, agent, false, "Synced from CLI");
          console.log(`✅ Sync complete!`);
        } else {
          // Task still running — attach live sync
          await webSync.setupAgentSync(agent, knowhowTaskId);
          console.log(
            `✅ Live sync attached! Thread updates will push as the agent runs.`
          );
        }
      } else {
        console.log("⚠️  Agent not found in task info; skipping live sync.");
      }

      this.syncedMessageCount++;

      const baseUrl = KNOWHOW_API_URL.replace("/api", "").replace(
        "api.",
        ""
      );
      console.log(
        `\n💾 Local session updated with remote IDs.\n` +
          `🌐 View your task at: ${baseUrl}/chat/${sessionId}`
      );
    } catch (error: any) {
      console.error(
        `❌ Remote sync failed: ${error?.message || error}\n` +
          `   Local state is unaffected. You can retry with /sync:remote.`
      );
    }
  }

  /**
   * Handle /sync:remote:off
   */
  private async handleSyncRemoteOff(_args: string[]): Promise<void> {
    this.autoSync = false;
    try {
      const config = await getConfig();
      await updateConfig({ ...config, syncRemote: false });
      console.log("💾 Config updated: syncRemote set to false");
    } catch (e: any) {
      console.log(`⚠️  Could not update config: ${e?.message}`);
    }
    console.log(
      "🔕 Remote auto-sync disabled for future tasks.\n" +
        "   Existing synced tasks will continue to push updates.\n" +
        "   Use /sync:remote to manually sync a task."
    );
  }

  /**
   * Handle /sync:remote:on - enables auto-sync and persists to config
   */
  private async handleSyncRemoteOn(_args: string[]): Promise<void> {
    this.autoSync = true;
    try {
      const config = await getConfig();
      await updateConfig({ ...config, syncRemote: true });
      console.log("💾 Config updated: syncRemote set to true");
    } catch (e: any) {
      console.log(`⚠️  Could not update config: ${e?.message}`);
    }
    console.log(
      "📡 Remote auto-sync enabled for all future agent tasks.\n" +
        "   Every new agent interaction will be pushed to the remote KnowHow app.\n" +
        "   Use /sync:remote:off to disable."
    );
  }

  /**
   * Handle /sync:status
   */
  private async handleSyncStatus(_args: string[]): Promise<void> {
    const lines: string[] = ["\n📊 Remote Sync Status"];
    lines.push("─".repeat(50));

    if (this.workerId) {
      lines.push(`🔧 Worker ID: ${this.workerId}`);
    } else {
      lines.push(`🔧 Worker ID: not set (start worker to register)`);
    }

    if (this.remoteSessionId) {
      lines.push(`✅ Remote session active: ${this.remoteSessionId}`);
    } else {
      lines.push("❌ No remote session (run /sync:remote to create one)");
    }

    lines.push(
      `🔄 Auto-sync: ${this.autoSync ? "enabled" : "disabled"}`
    );
    lines.push(`📨 Messages synced this session: ${this.syncedMessageCount}`);

    // Show active tasks that have been synced
    const registry = this.agentModule.getTaskRegistry();
    const syncedTasks = registry
      .getAll()
      .filter((t) => t.knowhowTaskId && t.chatSessionId);

    if (syncedTasks.length > 0) {
      lines.push("\nSynced tasks:");
      syncedTasks.forEach((t) => {
        lines.push(
          `  • ${t.taskId.slice(0, 40)} → ${t.knowhowTaskId} (${t.status})`
        );
      });
    }

    lines.push("─".repeat(50));
    console.log(lines.join("\n"));
  }

  /**
   * Whether auto-sync is currently enabled.
   */
  public isAutoSyncEnabled(): boolean {
    return this.autoSync;
  }

  /**
   * Get the current remote session ID (if any).
   */
  public getRemoteSessionId(): string | undefined {
    return this.remoteSessionId;
  }
}
