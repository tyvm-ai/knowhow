/**
 * Sessions Chat Module - Handles session/attachment related commands
 * Extracted from AgentModule to keep AgentModule focused on agent running logic.
 *
 * Command semantics:
 *   /attach <taskId>  - Attach to a RUNNING session (in-memory, filesystem, or web).
 *                       If the task is completed, the user is told to use /resume instead.
 *   /resume <taskId>  - Resume a COMPLETED/saved session with optional additional context.
 *   /sessions         - List sessions that can be attached to or resumed.
 *   /logs [N]         - Show the last N messages from the currently attached agent.
 */
import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatMode, ChatContext } from "../types";
import { AgentModule } from "./AgentModule";
import {
  FsSyncedAgentWatcher,
  WebSyncedAgentWatcher,
  WatcherBackedAgent,
} from "../../services/index";
import { TaskInfo, ChatSession } from "../types";
import { agents } from "../../agents";
import { KnowhowSimpleClient } from "../../services/KnowhowClient";
import { messagesToRenderEvents } from "../renderer/messagesToRenderEvents";
import { Marked } from "../../utils/index";
import * as fs from "fs";
import * as path from "path";

export class SessionsModule extends BaseChatModule {
  name = "sessions";
  description = "Session and attachment management";

  private agentModule: AgentModule;

  constructor(agentModule: AgentModule) {
    super();
    this.agentModule = agentModule;
  }

  getCommands(): ChatCommand[] {
    return [
      {
        name: "attach",
        description:
          "Attach to a RUNNING session. Use --completed to also see completed sessions.",
        handler: this.handleAttachCommand.bind(this),
      },
      {
        name: "resume",
        description:
          "Resume a completed/saved session with optional additional context",
        handler: this.handleResumeCommand.bind(this),
      },
      {
        name: "sessions",
        description:
          "List running sessions. Use --completed to also show completed/saved sessions.",
        handler: this.handleSessionsCommand.bind(this),
      },
      {
        name: "logs",
        description: "Show recent messages from attached agent [N=20]",
        handler: this.handleLogsCommand.bind(this),
        modes: ["agent:attached"],
      },
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /logs [N]
  // ─────────────────────────────────────────────────────────────────────────────

  async handleLogsCommand(args: string[]): Promise<void> {
    const count = parseInt(args[0] || "20", 10) || 20;
    const activeSyncedWatcher = this.agentModule.getActiveSyncedWatcher();
    const renderer = this.agentModule.getRenderer();
    const taskRegistry = this.agentModule.getTaskRegistry();

    try {
      // Prefer the synced watcher (fs or web attach)
      if (activeSyncedWatcher) {
        const threads = await activeSyncedWatcher.getThreads();
        const lastThread = threads[threads.length - 1] || [];
        const events = messagesToRenderEvents(
          lastThread,
          activeSyncedWatcher.taskId,
          activeSyncedWatcher.agentName
        );
        renderer.logMessages(events, count);
        return;
      }

      // Fall back to in-process task
      const activeTaskId = renderer.getActiveTaskId();
      if (activeTaskId && taskRegistry.has(activeTaskId)) {
        const taskInfo = taskRegistry.get(activeTaskId);
        const agent = taskInfo?.agent;
        if (agent) {
          const threads = agent.getThreads();
          const lastThread = threads[threads.length - 1] || [];
          const events = messagesToRenderEvents(
            lastThread,
            activeTaskId,
            agent.name
          );
          renderer.logMessages(events, count);
          return;
        }
      }

      console.log(
        "No active agent to show logs for. Use /attach <taskId> to attach to an agent first."
      );
    } catch (error) {
      console.error("Error showing logs:", error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Numbered selection helper
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Shows a prompt and accepts a number (1-based index) to select from a list of IDs.
   * Returns the resolved ID, or undefined if cancelled.
   */
  private async selectByNumber(
    prompt: string,
    allIds: string[]
  ): Promise<string | undefined> {
    const numbers = allIds.map((_, i) => String(i + 1));
    const input = await this.chatService?.getInput(prompt, numbers);
    if (!input || !input.trim()) return undefined;
    const idx = parseInt(input.trim(), 10);
    if (isNaN(idx) || idx < 1 || idx > allIds.length) return undefined;
    return allIds[idx - 1];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /attach [taskId]
  // Attaches to a RUNNING session only.  Completed sessions → suggest /resume.
  // ─────────────────────────────────────────────────────────────────────────────

  async handleAttachCommand(args: string[]): Promise<void> {
    const taskRegistry = this.agentModule.getTaskRegistry();
    const sessionManager = this.agentModule.getSessionManager();
    const showCompleted = args.includes("--completed");
    const filteredArgs = args.filter((a) => a !== "--completed");

    if (filteredArgs.length === 0) {
      // Build list of running-only sessions for interactive selection
      const runningTasks = taskRegistry.getAll();
      const fsAgents = await this.getFsAgents(runningTasks);
      // If --completed flag, also fetch saved/completed sessions
      const savedSessions = showCompleted
        ? sessionManager.listAvailableSessions()
        : [];

      if (
        runningTasks.length === 0 &&
        fsAgents.length === 0 &&
        savedSessions.length === 0
      ) {
        console.log(
          "No running sessions found to attach to.\n" +
            "Use /attach --completed to also see completed sessions.\n" +
            "Use /resume <taskId> to resume a completed session."
        );
        return;
      }

      if (showCompleted) {
        this.logSessionsCompact(runningTasks, savedSessions, fsAgents);
      } else {
        this.printRunningTable(runningTasks, fsAgents);
      }

      const allIds = [
        ...runningTasks.map((t) => t.taskId),
        ...fsAgents.map((a) => a.taskId),
        ...(showCompleted ? savedSessions.map((s) => s.sessionId) : []),
      ];

      const selectedId = await this.selectByNumber(
        showCompleted
          ? "Enter number to attach/resume (or press Enter to cancel): "
          : "Enter number to attach to (or press Enter to cancel): ",
        allIds
      );

      if (selectedId) {
        const trimmed = selectedId;
        const isCompleted =
          showCompleted && savedSessions.some((s) => s.sessionId === trimmed);
        if (isCompleted) {
          await this.resumeById(trimmed);
        } else {
          await this.attachById(trimmed);
        }
      }
      return;
    }

    const taskId = filteredArgs[0];
    await this.attachById(taskId);
  }

  /**
   * Core attach logic — only attaches to RUNNING sessions.
   * Completed/saved sessions get a helpful message pointing to /resume.
   */
  private async attachById(id: string): Promise<void> {
    const taskRegistry = this.agentModule.getTaskRegistry();
    const sessionManager = this.agentModule.getSessionManager();

    // ── Case 1: in-memory running task ──────────────────────────────────────
    if (taskRegistry.has(id)) {
      const taskInfo = taskRegistry.get(id)!;
      const renderer = this.agentModule.getRenderer();
      const context = this.chatService?.getContext();
      const allAgents = agents();
      const selectedAgent = allAgents[taskInfo.agentName];

      if (context && selectedAgent) {
        context.selectedAgent = selectedAgent;
        context.agentMode = true;
        context.currentAgent = taskInfo.agentName;
        context.activeAgentTaskId = id;
        context.currentModel = selectedAgent.getModel();
        context.currentProvider = selectedAgent.getProvider();
      }
      this.agentModule.setActiveAgentTaskId(id);
      renderer.setActiveTaskId(id);
      if (this.chatService) this.chatService.setMode("agent:attached");

      console.log(`🔄 Attached to running task: ${id}`);
      console.log(`   Agent : ${taskInfo.agentName}`);
      console.log(`   Task  : ${taskInfo.initialInput}`);
      console.log(`   Status: ${taskInfo.status}`);
      console.log(
        `   Type /logs to see recent messages, or /detach to detach.`
      );
      return;
    }

    // ── Case 2: filesystem agent directory ──────────────────────────────────
    const fsAgentPath = path.join(".knowhow", "processes", "agents", id);
    if (fs.existsSync(fsAgentPath)) {
      // Read status — only attach if running
      const status = this.readFsAgentStatus(fsAgentPath);
      if (status === "completed") {
        console.log(
          `⚠️  Task ${id} is completed.\n` +
            `   Use /resume ${id} to resume it with additional context.`
        );
        return;
      }
      await this.attachToFsAgent(id);
      return;
    }

    // ── Case 3: saved session (completed) ───────────────────────────────────
    try {
      const session = sessionManager.loadSession(id);
      if (session) {
        if (session.status === "completed") {
          console.log(
            `⚠️  Session ${id} is completed.\n` +
              `   Use /resume ${id} to resume it with additional context.`
          );
        } else {
          // Session exists but is not yet completed — treat as attach via fs watcher
          // (the agent may be running in another process)
          const fsPath = path.join(".knowhow", "processes", "agents", id);
          if (fs.existsSync(fsPath)) {
            await this.attachToFsAgent(id);
          } else {
            // Try web as last resort
            await this.attachToWebAgent(id);
          }
        }
        return;
      }
    } catch {
      // session not on disk, continue
    }

    // ── Case 4: web task ────────────────────────────────────────────────────
    try {
      await this.attachToWebAgent(id);
      return;
    } catch {
      // not found on web
    }

    console.log(
      `Session/Task "${id}" not found among running tasks, filesystem agents, or web.\n` +
        `Use /sessions to see all known sessions.`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /resume [taskId]
  // Resumes a completed/saved session with optional additional context.
  // ─────────────────────────────────────────────────────────────────────────────

  async handleResumeCommand(args: string[]): Promise<void> {
    const sessionManager = this.agentModule.getSessionManager();

    if (args.length === 0) {
      // Interactive: show saved sessions for selection
      const savedSessions = sessionManager.listAvailableSessions();
      if (savedSessions.length === 0) {
        console.log("No saved sessions found to resume.");
        return;
      }

      this.printSavedSessionsTable(savedSessions);

      const allIds = savedSessions.map((s) => s.sessionId);
      const selectedId = await this.selectByNumber(
        "Enter number to resume (or press Enter to cancel): ",
        allIds
      );

      if (selectedId) {
        await this.resumeById(selectedId);
      }
      return;
    }

    await this.resumeById(args[0]);
  }

  private async resumeById(id: string): Promise<void> {
    const sessionManager = this.agentModule.getSessionManager();

    // Check saved sessions first
    try {
      const session = sessionManager.loadSession(id);
      if (session) {
        console.log(`\n📋 Session found: ${id}`);
        console.log(`   Agent  : ${session.agentName}`);
        console.log(`   Task   : ${session.initialInput}`);
        console.log(`   Status : ${session.status}`);

        const additionalContext = await this.chatService?.getInput(
          "Add any additional context for resuming this session (or press Enter to skip): "
        );
        await this.agentModule.resumeSession(
          id,
          additionalContext?.trim() || undefined
        );
        return;
      }
    } catch {
      // not found as a saved session
    }

    // Check filesystem agent (may have metadata with threads)
    const fsAgentPath = path.join(".knowhow", "processes", "agents", id);
    if (fs.existsSync(fsAgentPath)) {
      console.log(
        `⚠️  Task ${id} exists in the filesystem but has no saved session.\n` +
          `   Use /attach ${id} if it is still running.`
      );
      return;
    }

    console.log(
      `Session "${id}" not found. Use /sessions to list available sessions.`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // /sessions [--all] [--csv]
  // Shows all sessions: running ones can be /attach'd, saved ones can be /resume'd
  // ─────────────────────────────────────────────────────────────────────────────

  async handleSessionsCommand(args: string[]): Promise<void> {
    try {
      const showCompleted =
        args.includes("--completed") || args.includes("--all");
      const showCsv = args.includes("--csv");

      const taskRegistry = this.agentModule.getTaskRegistry();
      const sessionManager = this.agentModule.getSessionManager();
      const runningTasks = taskRegistry.getAll();
      const fsAgents = await this.getFsAgents(runningTasks);
      // Only include saved/completed sessions when --completed (or --all) is passed
      const savedSessions = showCompleted
        ? sessionManager.listAvailableSessions()
        : [];

      if (showCompleted) {
        // Show running + completed together
        await this.logSessionTable(true, showCsv, true);
      } else {
        // Only show running tasks + fs agents
        if (runningTasks.length === 0 && fsAgents.length === 0) {
          console.log(
            "No running sessions. Use /sessions --completed to also see completed sessions."
          );
        } else if (showCsv) {
          this.logSessionsCsv(runningTasks, [], fsAgents);
        } else {
          this.logSessionsCompact(runningTasks, [], fsAgents);
        }
      }

      // Interactive selection — running → attach, completed → resume
      const allIds = [
        ...runningTasks.map((t) => t.taskId),
        ...fsAgents.map((a) => a.taskId),
        ...savedSessions.map((s) => s.sessionId),
      ];

      if (allIds.length > 0) {
        const selectedId = await this.selectByNumber(
          showCompleted
            ? "Enter number to attach/resume (or press Enter to skip): "
            : "Enter number to attach to (or press Enter to skip): ",
          allIds
        );

        if (selectedId) {
          const isRunning =
            taskRegistry.has(selectedId) ||
            fsAgents.some((a) => a.taskId === selectedId);

          if (isRunning) {
            await this.attachById(selectedId);
          } else {
            await this.resumeById(selectedId);
          }
        }
      }
    } catch (error) {
      console.error("Error listing sessions and tasks:", error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Table rendering helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Main session table — shows running, saved, and fs agents.
   */
  async logSessionTable(
    all: boolean = false,
    csv: boolean = false,
    includeFs: boolean = false
  ) {
    const taskRegistry = this.agentModule.getTaskRegistry();
    const sessionManager = this.agentModule.getSessionManager();
    const runningTasks = taskRegistry.getAll();
    let savedSessions = sessionManager.listAvailableSessions();

    if (!all) {
      savedSessions = savedSessions.filter(
        (s) => s.startTime >= this.agentModule.getProcessStartTime()
      );
      const filteredTasks = runningTasks.filter(
        (t) => t.startTime >= this.agentModule.getProcessStartTime()
      );

      const fsAgents = includeFs ? await this.getFsAgents(runningTasks) : [];
      if (
        filteredTasks.length === 0 &&
        savedSessions.length === 0 &&
        fsAgents.length === 0
      ) {
        console.log(
          "No sessions from this process run. Use --all to see all historical sessions."
        );
        return;
      }

      if (csv) {
        this.logSessionsCsv(filteredTasks, savedSessions, fsAgents);
      } else {
        this.logSessionsCompact(filteredTasks, savedSessions, fsAgents);
      }
      return;
    }

    const fsAgents = includeFs
      ? await this.getFsAgentsIncludingCompleted(runningTasks)
      : [];
    if (csv) {
      this.logSessionsCsv(runningTasks, savedSessions, fsAgents);
    } else {
      this.logSessionsCompact(runningTasks, savedSessions, fsAgents);
    }
  }

  /** Compact table of ONLY running tasks + fs agents (for /attach interactive) */
  private printRunningTable(
    runningTasks: TaskInfo[],
    fsAgents: {
      taskId: string;
      agentName: string;
      status: string;
      totalCostUsd?: number;
    }[]
  ): void {
    const rows = [
      ...runningTasks.map((t) => ({
        id: t.taskId,
        agent: t.agentName,
        status: t.status,
        cost: `$${t.totalCost.toFixed(3)}`,
        type: "running",
      })),
      ...fsAgents.map((a) => ({
        id: a.taskId,
        agent: a.agentName,
        status: a.status,
        cost: a.totalCostUsd != null ? `$${a.totalCostUsd.toFixed(3)}` : "n/a",
        type: "fs",
      })),
    ];

    console.log("\n🏃 Running sessions (attach-able):");
    console.log("─".repeat(86));
    console.log(
      "#".padEnd(5) +
        "taskId".padEnd(40) +
        "agent".padEnd(14) +
        "status".padEnd(12) +
        "cost"
    );
    console.log("─".repeat(86));
    for (const r of rows) {
      const num = String(rows.indexOf(r) + 1).padEnd(5);
      const shortId = r.id.length > 38 ? r.id.substring(0, 35) + "..." : r.id;
      console.log(
        num +
          shortId.padEnd(40) +
          r.agent.padEnd(14) +
          r.status.padEnd(12) +
          r.cost
      );
    }
    console.log("─".repeat(86));
  }

  /** Compact table of ONLY saved sessions (for /resume interactive) */
  private printSavedSessionsTable(savedSessions: ChatSession[]): void {
    console.log("\n💾 Saved sessions (resumable):");
    console.log("─".repeat(86));
    console.log(
      "#".padEnd(5) +
        "taskId".padEnd(40) +
        "agent".padEnd(14) +
        "status".padEnd(12) +
        "cost"
    );
    console.log("─".repeat(86));
    for (let i = 0; i < savedSessions.length; i++) {
      const s = savedSessions[i];
      const num = String(i + 1).padEnd(5);
      const shortId =
        s.sessionId.length > 38
          ? s.sessionId.substring(0, 35) + "..."
          : s.sessionId;
      const cost = s.totalCost ? `$${s.totalCost.toFixed(3)}` : "$0.000";
      console.log(
        num +
          shortId.padEnd(40) +
          s.agentName.padEnd(14) +
          s.status.padEnd(12) +
          cost
      );
    }
    console.log("─".repeat(86));
  }

  /**
   * Full compact list: running + saved + fs agents, with type labels.
   */
  private logSessionsCompact(
    runningTasks: TaskInfo[],
    savedSessions: ChatSession[],
    fsAgents: {
      taskId: string;
      agentName: string;
      status: string;
      totalCostUsd?: number;
    }[] = []
  ): void {
    const runningTaskIds = new Set(runningTasks.map((t) => t.taskId));
    const savedIds = new Set(savedSessions.map((s) => s.sessionId));
    const dedupedSaved = savedSessions.filter(
      (s) => !runningTaskIds.has(s.sessionId)
    );
    const allKnownIds = new Set([...runningTaskIds, ...savedIds]);
    const dedupedFs = fsAgents.filter((a) => !allKnownIds.has(a.taskId));

    const rows = [
      ...runningTasks.map((t) => ({
        id: t.taskId,
        agent: t.agentName,
        status: t.status,
        cost: `$${t.totalCost.toFixed(3)}`,
        type: "running",
        action: "/attach",
      })),
      ...dedupedFs.map((a) => ({
        id: a.taskId,
        agent: a.agentName,
        status: a.status,
        cost: a.totalCostUsd != null ? `$${a.totalCostUsd.toFixed(3)}` : "n/a",
        type: "fs",
        action: a.status === "completed" ? "/resume" : "/attach",
      })),
      ...dedupedSaved.map((s) => ({
        id: s.sessionId,
        agent: s.agentName,
        status: s.status,
        cost: s.totalCost ? `$${s.totalCost.toFixed(3)}` : "$0.000",
        type: "saved",
        action: "/resume",
      })),
    ];

    if (rows.length === 0) {
      console.log("No sessions found.");
      return;
    }

    console.log("\n📋 Sessions:");
    console.log("─".repeat(109));
    console.log(
      "#".padEnd(5) +
        "taskId".padEnd(40) +
        "agent".padEnd(14) +
        "status".padEnd(12) +
        "type".padEnd(10) +
        "cost".padEnd(12) +
        "action"
    );
    console.log("─".repeat(109));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const num = String(i + 1).padEnd(5);
      const shortId = r.id.length > 38 ? r.id.substring(0, 35) + "..." : r.id;
      console.log(
        num +
          shortId.padEnd(40) +
          r.agent.padEnd(14) +
          r.status.padEnd(12) +
          r.type.padEnd(10) +
          r.cost.padEnd(12) +
          r.action
      );
    }
    console.log("─".repeat(109));
  }

  /**
   * CSV output for sessions.
   */
  private logSessionsCsv(
    runningTasks: TaskInfo[],
    savedSessions: ChatSession[],
    fsAgents: {
      taskId: string;
      agentName: string;
      status: string;
      totalCostUsd?: number;
    }[] = []
  ): void {
    const lines = ["taskId,agent,status,type,cost,startTime,initialInput"];
    const runningTaskIds = new Set(runningTasks.map((t) => t.taskId));
    const dedupedSaved = savedSessions.filter(
      (s) => !runningTaskIds.has(s.sessionId)
    );

    for (const t of runningTasks) {
      const input = (t.initialInput || "")
        .replace(/,/g, ";")
        .replace(/\n/g, " ");
      lines.push(
        `${t.taskId},${t.agentName},${t.status},running,${
          t.totalCost?.toFixed(3) || "0.000"
        },${t.startTime},"${input}"`
      );
    }
    for (const s of dedupedSaved) {
      const input = (s.initialInput || "")
        .replace(/,/g, ";")
        .replace(/\n/g, " ");
      lines.push(
        `${s.sessionId},${s.agentName},${s.status},saved,${
          s.totalCost?.toFixed(3) || "0.000"
        },${s.startTime},"${input}"`
      );
    }
    const allKnownIds = new Set([
      ...runningTaskIds,
      ...savedSessions.map((s) => s.sessionId),
    ]);
    for (const a of fsAgents) {
      if (!allKnownIds.has(a.taskId)) {
        lines.push(
          `${a.taskId},${a.agentName},${a.status},fs,${
            a.totalCostUsd != null ? a.totalCostUsd.toFixed(3) : "n/a"
          },n/a,""`
        );
      }
    }
    console.log(lines.join("\n"));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Low-level attach helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async attachToFsAgent(taskId: string): Promise<void> {
    const existingWatcher = this.agentModule.getActiveSyncedWatcher();
    if (existingWatcher) {
      existingWatcher.stopWatching();
      this.agentModule.setActiveSyncedWatcher(undefined);
    }

    const watcher = new FsSyncedAgentWatcher();
    await watcher.startWatching(taskId);
    this.agentModule.setActiveSyncedWatcher(watcher);

    // Wire rendering via AgentModule utility (handles cleanup on detach)
    this.agentModule.wireAgentRendering(taskId, watcher.agentEvents, watcher.eventTypes, watcher.agentName);
    watcher.agentEvents.once(watcher.eventTypes.done, (output) => {
      console.log(Marked.parse(output));
    });

    const context = this.chatService?.getContext();
    if (context) context.activeAgentTaskId = taskId;

    console.log(`📁 Attached to filesystem agent: ${taskId}`);

    // Enter interactive loop — this sets mode to "agent:attached" and blocks until detach/done/kill
    const fsWatcherAgent = new WatcherBackedAgent(watcher);
    await this.agentModule.attachedAgentChatLoop(taskId, fsWatcherAgent);
  }

  private async attachToWebAgent(taskId: string): Promise<void> {
    const client = new KnowhowSimpleClient();
    // Verify the task exists — throws if not found
    const details = await client.getTaskDetails(taskId);

    // Check if it's already completed on the web
    const webStatus = details?.data?.status;
    if (webStatus === "completed" || webStatus === "killed") {
      console.log(
        `⚠️  Web task ${taskId} has status: ${webStatus}.\n` +
          `   Use /resume ${taskId} to resume it with additional context.`
      );
      return;
    }

    const existingWatcher = this.agentModule.getActiveSyncedWatcher();
    if (existingWatcher) {
      existingWatcher.stopWatching();
      this.agentModule.setActiveSyncedWatcher(undefined);
    }

    const watcher = new WebSyncedAgentWatcher(client);
    await watcher.startWatching(taskId);
    this.agentModule.setActiveSyncedWatcher(watcher);

    // Wire rendering via AgentModule utility (handles cleanup on detach)
    this.agentModule.wireAgentRendering(taskId, watcher.agentEvents, watcher.eventTypes, watcher.agentName);

    const context = this.chatService?.getContext();
    if (context) context.activeAgentTaskId = taskId;

    console.log(`🌐 Attached to web agent: ${taskId}`);

    // Enter interactive loop — this sets mode to "agent:attached" and blocks until detach/done/kill
    const webWatcherAgent = new WatcherBackedAgent(watcher);
    await this.agentModule.attachedAgentChatLoop(taskId, webWatcherAgent);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private readFsAgentStatus(agentPath: string): string {
    try {
      const statusPath = path.join(agentPath, "status.txt");
      if (fs.existsSync(statusPath)) {
        return fs.readFileSync(statusPath, "utf8").trim();
      }
      // Fall back to metadata.json
      const metaPath = path.join(agentPath, "metadata.json");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return meta.status || "unknown";
      }
    } catch {
      // ignore
    }
    return "unknown";
  }

  private async getFsAgents(runningTasks: TaskInfo[]): Promise<
    {
      taskId: string;
      agentName: string;
      status: string;
      totalCostUsd?: number;
    }[]
  > {
    const sessionManager = this.agentModule.getSessionManager();
    const registeredIds = new Set(runningTasks.map((t) => t.taskId));
    return sessionManager.discoverFsAgents(registeredIds);
  }

  private async getFsAgentsIncludingCompleted(
    runningTasks: TaskInfo[]
  ): Promise<
    {
      taskId: string;
      agentName: string;
      status: string;
      totalCostUsd?: number;
    }[]
  > {
    const sessionManager = this.agentModule.getSessionManager();
    const registeredIds = new Set(runningTasks.map((t) => t.taskId));
    return sessionManager.discoverFsAgents(registeredIds, true);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public helpers used by CLI (src/cli.ts)
  // ─────────────────────────────────────────────────────────────────────────────

  public async listAvailableSessions(): Promise<ChatSession[]> {
    return this.agentModule.getSessionManager().listAvailableSessions();
  }

  public async listSessionsAndTasks(): Promise<{
    runningTasks: TaskInfo[];
    savedSessions: ChatSession[];
  }> {
    const taskRegistry = this.agentModule.getTaskRegistry();
    const sessionManager = this.agentModule.getSessionManager();
    return {
      runningTasks: taskRegistry.getAll(),
      savedSessions: sessionManager.listAvailableSessions(),
    };
  }
}
