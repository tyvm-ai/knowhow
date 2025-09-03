/**
 * Agent Chat Module - Handles agent interactions
 */
import { KnowhowSimpleClient } from "../../services/KnowhowClient";
import * as fs from "fs";
import * as path from "path";

import { BaseChatModule } from "./BaseChatModule";
import { services } from "../../services/index";
import { BaseAgent } from "../../agents/index";
import { ChatCommand, ChatMode, ChatContext, ChatService } from "../types";
import { ChatInteraction } from "../../types";
import { Marked } from "../../utils/index";
import { TokenCompressor } from "../../processors/TokenCompressor";
import { ToolResponseCache } from "../../processors/ToolResponseCache";
import {
  CustomVariables,
  XmlToolCallProcessor,
  HarmonyToolProcessor,
} from "../../processors/index";
import { TaskInfo, ChatSession } from "../types";
import { agents } from "../../agents";

export class AgentModule extends BaseChatModule {
  name = "agent";
  description = "Agent interaction functionality";

  // Enhanced task registry for managing agents with metadata
  private taskRegistry = new Map<string, TaskInfo>();

  // Sessions directory path
  private sessionsDir = "./.knowhow/chats/sessions";

  constructor() {
    super();
    // Ensure sessions directory exists
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  getCommands(): ChatCommand[] {
    return [
      {
        name: "agent",
        description: "Start an agent by name",
        handler: this.handleAgentCommand.bind(this),
      },
      {
        name: "agents",
        description: "List available agents",
        handler: this.handleAgentsCommand.bind(this),
      },
      {
        name: "attach",
        description: "Attach to a running session or resume an old session",
        handler: this.handleAttachCommand.bind(this),
      },
      {
        name: "sessions",
        description: "List active tasks and saved sessions",
        handler: this.handleSessionsCommand.bind(this),
      },
    ];
  }

  getModes(): ChatMode[] {
    return [
      {
        name: "agent",
        description: "Agent interaction mode",
        active: true,
      },
    ];
  }

  async initialize(service: ChatService): Promise<void> {
    await super.initialize(service);
    await this.handleAgentCommand(["Patcher"]);
  }

  async handleAgentCommand(args: string[]): Promise<void> {
    const context = this.chatService?.getContext();

    // If no args provided, toggle agent mode
    if (args.length === 0) {
      if (context?.agentMode) {
        // Disable agent mode
        if (context) {
          context.agentMode = false;
          context.selectedAgent = undefined;
          context.currentAgent = undefined;
        }
        console.log("Agent mode disabled. Switched to chat mode.");
        return;
      } else {
        // Show usage when not in agent mode and no args
        console.log(
          "Agent mode is currently disabled. Use /agent <agent_name> to enable it, or /agents to list available agents."
        );
        return;
      }
    }

    const agentName = args[0];
    const allAgents = agents();

    try {
      if (allAgents && allAgents[agentName]) {
        // Set selected agent in context and enable agent mode
        if (context) {
          context.selectedAgent = allAgents[agentName];
          context.agentMode = true;
          context.currentAgent = agentName;
        }
        console.log(
          `Agent mode enabled. Selected agent: ${agentName}. Type your task to get started.`
        );
      } else {
        console.log(
          `Agent "${agentName}" not found. Use /agents to list available agents.`
        );
      }
    } catch (error) {
      console.error(`Error selecting agent ${agentName}:`, error);
    }
  }

  async handleAttachCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      // Get both running tasks and saved sessions
      const runningTasks = Array.from(this.taskRegistry.values());
      const savedSessions = await this.listAvailableSessions();

      if (runningTasks.length === 0 && savedSessions.length === 0) {
        console.log("No active tasks or saved sessions found to attach to.");
        return;
      }

      // Show available options for selection
      console.log("\n📋 Available Sessions & Tasks:");
      console.log("─".repeat(80));
      console.log(
        "ID".padEnd(25) + "Agent".padEnd(15) + "Status".padEnd(12) + "Type"
      );
      console.log("─".repeat(80));

      // Show saved sessions
      savedSessions.forEach((session) => {
        console.log(
          session.sessionId.padEnd(25) +
            session.agentName.padEnd(15) +
            session.status.padEnd(12) +
            "saved"
        );
      });

      // Show running tasks
      runningTasks.forEach((task) => {
        console.log(
          task.taskId.padEnd(25) +
            task.agentName.padEnd(15) +
            task.status.padEnd(12) +
            "running"
        );
      });

      console.log("─".repeat(80));

      // Interactive selection for both types
      const allIds = [
        ...savedSessions.map((s) => s.sessionId),
        ...runningTasks.map((t) => t.taskId),
      ];

      const selectedId = await this.chatService?.getInput(
        "Select a session/task to attach to (or press Enter to skip): ",
        allIds
      );

      if (
        selectedId &&
        selectedId.trim() &&
        allIds.includes(selectedId.trim())
      ) {
        await this.handleAttachById(selectedId.trim());
      }
      return;
    }

    const taskId = args[0];
    await this.handleAttachById(taskId);
  }

  /**
   * Display single task details
   */
  private displaySingleTask(task: TaskInfo): void {
    console.log(`\n📋 Task Details: ${task.taskId}`);
    console.log("─".repeat(50));
    console.log(`Agent: ${task.agentName}`);
    console.log(`Status: ${task.status}`);
    console.log(`Initial Input: ${task.initialInput}`);
    console.log(`Start Time: ${new Date(task.startTime).toLocaleString()}`);
    if (task.endTime) {
      console.log(`End Time: ${new Date(task.endTime).toLocaleString()}`);
      console.log(
        `Duration: ${Math.round((task.endTime - task.startTime) / 1000)}s`
      );
    } else {
      console.log(
        `Running for: ${Math.round((Date.now() - task.startTime) / 1000)}s`
      );
    }
    console.log(`Total Cost: $${task.totalCost.toFixed(3)}`);
    console.log("─".repeat(50));
  }

  async handleAgentsCommand(args: string[]): Promise<void> {
    try {
      const allAgents = agents();

      if (allAgents && Object.keys(allAgents).length > 0) {
        const agentNames = Object.keys(allAgents);

        console.log("\nAvailable agents:");
        Object.entries(allAgents).forEach(([name, agent]: [string, any]) => {
          console.log(`  - ${name}: ${agent.description || "No description"}`);
        });
        console.log("─".repeat(80), "\n");

        // Interactive selection with autocomplete
        const selectedAgent = await this.chatService?.getInput(
          "Select an agent to start: ",
          agentNames // Pass agent names as autocomplete options
        );

        if (
          selectedAgent &&
          selectedAgent.trim() &&
          agentNames.includes(selectedAgent.trim())
        ) {
          // Start the selected agent
          await this.handleAgentCommand([selectedAgent.trim()]);
        } else if (selectedAgent && selectedAgent.trim()) {
          console.log(`Agent "${selectedAgent.trim()}" not found.`);
        }
      } else {
        console.log("No agents available.");
      }
    } catch (error) {
      console.error("Error listing agents:", error);
      console.log("Could not load agents list.");
    }
  }

  async logSessionTable() {
    // Display unified table
    const runningTasks = Array.from(this.taskRegistry.values());
    const savedSessions = await this.listAvailableSessions();
    console.log("\n📋 Sessions & Tasks:");

    const data = [];
    // Display saved sessions first (historical)
    savedSessions.forEach((session) => {
      const lastUpdated = new Date(session.lastUpdated).toLocaleString();
      const inputPreview =
        session.initialInput && session.initialInput.length > 30
          ? session.initialInput.substring(0, 27) + "..."
          : session.initialInput || "[No input]";
      const cost = session.totalCost
        ? `$${session.totalCost.toFixed(3)}`
        : "$0.000";

      data.push({
        ID: session.sessionId,
        Agent: session.agentName,
        Status: session.status,
        Type: "saved",
        Time: lastUpdated,
        Cost: cost,
        "Initial Input": inputPreview,
      });
    });

    // Display running tasks at the bottom
    runningTasks.forEach((task) => {
      const elapsed = task.endTime
        ? `${Math.round((task.endTime - task.startTime) / 1000)}s`
        : `${Math.round((Date.now() - task.startTime) / 1000)}s`;
      const cost = `$${task.totalCost.toFixed(3)}`;
      const inputPreview =
        task.initialInput.length > 30
          ? task.initialInput.substring(0, 27) + "..."
          : task.initialInput;
      data.push({
        ID: task.taskId,
        Agent: task.agentName,
        Status: task.status,
        Type: "running",
        Time: elapsed,
        Cost: cost,
        "Initial Input": inputPreview,
      });
    });

    console.table(data);
  }

  async handleSessionsCommand(args: string[]): Promise<void> {
    try {
      // Get both running tasks and saved sessions
      const runningTasks = Array.from(this.taskRegistry.values());
      const savedSessions = await this.listAvailableSessions();

      if (runningTasks.length === 0 && savedSessions.length === 0) {
        console.log("No active tasks or saved sessions found.");
        return;
      }

      await this.logSessionTable();

      // Interactive selection for both types
      const allIds = [
        ...savedSessions.map((s) => s.sessionId),
        ...runningTasks.map((t) => t.taskId),
      ];

      if (allIds.length > 0) {
        const selectedId = await this.chatService?.getInput(
          "Select a session/task to attach to (or press Enter to skip): ",
          allIds
        );

        if (
          selectedId &&
          selectedId.trim() &&
          allIds.includes(selectedId.trim())
        ) {
          await this.handleAttachById(selectedId.trim());
        }
      }
    } catch (error) {
      console.error("Error listing sessions and tasks:", error);
    }
  }

  /**
   * Handle attachment by ID - works for both running tasks and saved sessions
   */
  private async handleAttachById(id: string): Promise<void> {
    // Check if it's a running task first
    if (this.taskRegistry.has(id)) {
      const taskInfo = this.taskRegistry.get(id);
      if (taskInfo) {
        // Switch to agent mode and set the selected agent
        const context = this.chatService?.getContext();
        const allAgents = agents();
        const selectedAgent = allAgents[taskInfo.agentName];

        if (context && selectedAgent) {
          context.selectedAgent = selectedAgent;
          context.agentMode = true;
          context.currentAgent = taskInfo.agentName;
          console.log(`🔄 Switched to agent mode with ${taskInfo.agentName}`);
          console.log(`📋 Attached to running task: ${id}`);
          console.log(`Task: ${taskInfo.initialInput}`);
          console.log(`Status: ${taskInfo.status}`);
          return;
        }
      }
      console.log(Marked.parse(`**Attached to running task: ${id}**`));
      return;
    }

    // Check if it's a saved session
    try {
      const sessionPath = path.join(this.sessionsDir, `${id}.json`);
      if (fs.existsSync(sessionPath)) {
        console.log(Marked.parse(`**Resuming saved session: ${id}**`));
        // Read session to get agent information
        const content = fs.readFileSync(sessionPath, "utf-8");
        const session: ChatSession = JSON.parse(content);

        // Switch to agent mode and set the selected agent
        const context = this.chatService?.getContext();
        const allAgents = agents();
        const selectedAgent = allAgents[session.agentName];

        if (context && selectedAgent) {
          context.selectedAgent = selectedAgent;
          context.agentMode = true;
          console.log(`🔄 Switched to agent mode with ${session.agentName}`);
          console.log(`📋 Resuming saved session: ${id}`);
          console.log(`Original task: ${session.initialInput}`);
          console.log(`Status: ${session.status}`);

          const addedContext = await this.chatService.getInput(
            "Add any additional context for resuming this session (or press Enter to skip): "
          );
          await this.resumeSession(id);
          return;
        }
      }
    } catch (error) {
      // Session file doesn't exist or error reading it
    }

    console.log(Marked.parse(`**Session/Task ${id} not found.**`));
  }

  /**
   * List available session files
   */
  public async listAvailableSessions(): Promise<ChatSession[]> {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessionFiles = files.filter((f) => f.endsWith(".json"));

      const sessions: ChatSession[] = [];
      const thresholdTime = 15 * 60 * 1000; // 15 minutes
      for (const file of sessionFiles) {
        const filePath = path.join(this.sessionsDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const session = JSON.parse(content) as ChatSession;

          // Cleanup check: mark stale running sessions as failed
          const isStale = Date.now() - session.lastUpdated > thresholdTime;
          const isRunningAndNotInRegistry =
            session.status === "running" &&
            !this.taskRegistry.has(session.sessionId);

          if (isRunningAndNotInRegistry && isStale) {
            console.log(
              `🧹 Marking stale session ${
                session.sessionId
              } as failed (last updated: ${new Date(
                session.lastUpdated
              ).toLocaleString()})`
            );
            session.status = "failed";
            session.lastUpdated = Date.now();
            // Update the session file with failed status
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
          }

          sessions.push(session);
        } catch (error) {
          console.warn(
            `Failed to read session file ${file}:`,
            (error as Error).message
          );
        }
      }

      return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
    } catch (error) {
      console.warn("Failed to list sessions:", (error as Error).message);
      return [];
    }
  }

  /**
   * List both active tasks and saved sessions for CLI usage
   */
  public async listSessionsAndTasks(): Promise<{
    runningTasks: TaskInfo[];
    savedSessions: ChatSession[];
  }> {
    const runningTasks = Array.from(this.taskRegistry.values());
    const savedSessions = await this.listAvailableSessions();
    return {
      runningTasks,
      savedSessions,
    };
  }

  /**
   * Get the task registry for CLI access
   */
  public getTaskRegistry(): Map<string, TaskInfo> {
    return this.taskRegistry;
  }

  /**
   * Resume a session from saved state
   */
  private async resumeSession(
    sessionId: string,
    resumeReason?: string
  ): Promise<void> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
      const content = fs.readFileSync(sessionPath, "utf-8");
      const session: ChatSession = JSON.parse(content);
      const lastThread = session.threads[session.threads.length - 1];
      console.log(`\n🔄 Resuming session: ${sessionId}`);
      console.log(`Agent: ${session.agentName}`);
      console.log(`Original task: ${session.initialInput}`);
      console.log(`Status: ${session.status}`);

      const reason = resumeReason
        ? `Reason for resuming:  ${resumeReason}`
        : "";

      // Create resume prompt
      const resumePrompt = `You are resuming a previously started task. Here's the context:
ORIGINAL REQUEST:
${session.initialInput}

LAST Progress State:
${JSON.stringify(lastThread)}

Please continue from where you left off and complete the original request.
${reason}

`;

      console.log("🚀 Session resumption would restart the agent here...");
      const context = this.chatService?.getContext() || {};
      const allAgents = agents();
      const selectedAgent =
        allAgents[session.agentName] || allAgents[context.currentAgent];

      if (!selectedAgent) {
        console.error(`Agent ${session.agentName} not found.`);
        return;
      }

      // Start agent with Knowhow task context if available
      const { agent, taskId } = await this.setupAgent({
        agentName: selectedAgent.name,
        input: resumePrompt,
        messageId: session.knowhowMessageId,
        existingKnowhowTaskId: session.knowhowTaskId,
        chatHistory: [],
        run: false, // Don't run yet, we need to set up event listeners first
      });
      await this.attachedAgentChatLoop(taskId, agent, resumePrompt);
    } catch (error) {
      console.error(
        `Failed to resume session ${sessionId}:`,
        (error as Error).message
      );
    }
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    // If in agent mode, start agent with the input as initial task (like original chat.ts)
    if (context.agentMode && context.selectedAgent) {
      // Create initial interaction for the chatHistory
      const initialInteraction: ChatInteraction = {
        input,
        output: "", // Will be filled after agent completion
        summaries: [],
        lastThread: [],
      };

      const { result, finalOutput } = await this.startAgent(
        context.selectedAgent,
        input,
        context.chatHistory || []
      );

      // Update the chatHistory with the completed interaction
      if (result && finalOutput) {
        initialInteraction.output = finalOutput;
        context.chatHistory.push(initialInteraction);
      }

      return result;
    }
    return false;
  }

  /**
   * Setup and run an agent directly with CLI options (for CLI usage)
   */
  public async setupAgent(options: {
    agentName: string;
    input: string;
    messageId?: string;
    existingKnowhowTaskId?: string;
    provider?: string;
    model?: string;
    maxTimeLimit?: number; // in minutes
    maxSpendLimit?: number; // in dollars
    chatHistory?: ChatInteraction[];
    run?: boolean; // whether to run immediately
  }) {
    const allAgents = agents();

    if (!allAgents[options.agentName]) {
      throw new Error(
        `Agent "${
          options.agentName
        }" not found. Available agents: ${Object.keys(allAgents).join(", ")}`
      );
    }

    const { input, chatHistory = [], agentName } = options;
    const agent = allAgents[options.agentName] as BaseAgent;

    let done = false;
    let output = "Done";
    const taskId = this.generateTaskId(input);
    let knowhowTaskId: string | undefined;

    try {
      // Create task info object
      let taskInfo: TaskInfo = {
        taskId,
        knowhowMessageId: options.messageId,
        knowhowTaskId: options.existingKnowhowTaskId, // Use existing or will be set after creating chat task
        agentName,
        agent,
        initialInput: input,
        status: "running",
        startTime: Date.now(),
        totalCost: 0,
      };

      // Add to task registry
      this.taskRegistry.set(taskId, taskInfo);

      // Save initial session
      this.saveSession(taskId, taskInfo, []);

      // Create Knowhow chat task if messageId provided
      const baseUrl = process.env.KNOWHOW_API_URL;
      console.log(
        `Base URL for Knowhow API: ${baseUrl}, Message ID: ${options.messageId}`
      );
      const client = new KnowhowSimpleClient(baseUrl);
      if (options.messageId && !options.existingKnowhowTaskId && baseUrl) {
        try {
          const response = await client.createChatTask({
            messageId: options.messageId,
            prompt: input,
          });
          knowhowTaskId = response.data.id;
          console.log(`✅ Created Knowhow chat task: ${knowhowTaskId}`);

          // Update TaskInfo with the created knowhowTaskId
          taskInfo.knowhowTaskId = knowhowTaskId;
          this.taskRegistry.set(taskId, taskInfo);
        } catch (error) {
          console.error(`❌ Failed to create Knowhow chat task:`, error);
          // Continue execution even if task creation fails
        }
      }

      // Set up session update listener
      agent.agentEvents.on("threadUpdate", async (threadState) => {
        // Update task cost from agent's current total cost
        taskInfo.totalCost = agent.getTotalCostUsd();
        this.updateSession(taskId, threadState);

        // Update Knowhow chat task if created
        if (knowhowTaskId && options.messageId && baseUrl) {
          await client
            .updateChatTask(knowhowTaskId, {
              threads: agent.getThreads(),
              totalCostUsd: agent.getTotalCostUsd(),
              inProgress: true,
            })
            .catch((error) => {
              console.error(`❌ Failed to update Knowhow chat task:`, error);
            });
          console.log(`✅ Updated Knowhow chat task: ${knowhowTaskId}`);
        }
      });

      console.log(
        Marked.parse(`**Starting ${agent.name} with task ID: ${taskId}...**`)
      );
      console.log(Marked.parse(`**Task:** ${input}`));

      // Initialize new task
      await agent.newTask(taskId);

      if (options.model) {
        console.log("Setting model:", options.model);
        agent.setModel(options.model);
        agent.setModelPreferences([
          { model: options.model, provider: options.provider as any },
        ]);
      }

      // Get context for plugins
      const context = this.chatService?.getContext();
      const plugins = context?.plugins || [];

      // Format the prompt with plugins and chat history
      const formattedPrompt = await this.chatService.formatChatInput(
        input,
        plugins,
        chatHistory
      );

      // Set up message processors like in original startAgent

      agent.messageProcessor.setProcessors("pre_call", [
        new ToolResponseCache(agent.tools).createProcessor(),
        new TokenCompressor(agent.tools).createProcessor((msg) =>
          Boolean(msg.role === "tool" && msg.tool_call_id)
        ),
        new CustomVariables(agent.tools).createProcessor(),
      ]);

      agent.messageProcessor.setProcessors("post_call", [
        new XmlToolCallProcessor().createProcessor(),
        new HarmonyToolProcessor().createProcessor(),
      ]);

      // Set up event listeners
      if (!agent.agentEvents.listenerCount(agent.eventTypes.toolUsed)) {
        agent.agentEvents.on(agent.eventTypes.toolUsed, (responseMsg) => {
          console.log(` 🔨 Tool used: ${JSON.stringify(responseMsg, null, 2)}`);
        });
      }

      const taskCompleted = new Promise<string>((resolve) => {
        agent.agentEvents.once(agent.eventTypes.done, async (doneMsg) => {
          console.log("Agent has completed the task.");
          done = true;
          output = doneMsg || "No response from the AI";
          // Update task info
          taskInfo = this.taskRegistry.get(taskId);
          if (taskInfo) {
            taskInfo.status = "completed";
            // Update final cost from agent
            taskInfo.totalCost = agent.getTotalCostUsd();
            // Update session with final state
            this.updateSession(taskId, agent.getThreads());
            taskInfo.endTime = Date.now();

            // Final update to Knowhow chat task
            if (knowhowTaskId && options.messageId) {
              console.log(
                `Updating Knowhow chat task on completion..., ${knowhowTaskId}, ${options.messageId}`
              );
              await client
                .updateChatTask(knowhowTaskId, {
                  inProgress: false,
                  threads: agent.getThreads(),
                  totalCostUsd: agent.getTotalCostUsd(),
                  result: output,
                })
                .catch((error) => {
                  console.error(
                    `❌ Failed to update Knowhow chat task on completion:`,
                    error
                  );
                });
              console.log(`✅ Completed Knowhow chat task: ${knowhowTaskId}`);
            }
          }
          console.log(Marked.parse(output));
          resolve(doneMsg);
        });
      });

      // Set up time limit if provided
      if (options.maxTimeLimit) {
        agent.setMaxRunTime(options.maxTimeLimit * 60 * 1000); // Convert minutes to milliseconds
      }

      console.log(`🤖 Starting agent: ${options.agentName}`);
      console.log(`📝 Task: ${options.input}`);

      if (options.maxTimeLimit) {
        console.log(`⏱️  Time limit: ${options.maxTimeLimit} minutes`);
      }
      if (options.maxSpendLimit) {
        console.log(`💰 Spend limit: $${options.maxSpendLimit}`);
      }
      console.log("─".repeat(50));

      if (options.run) {
        agent.call(formattedPrompt);
      }

      return { agent, taskId, formattedPrompt, taskCompleted };
    } catch (error) {
      console.error("Agent setup failed:", error);
      this.taskRegistry.delete(taskId);
    }
  }

  /**
   * Get list of active agent tasks
   */
  getActiveTasks(): { taskId: string; agent: TaskInfo }[] {
    return Array.from(this.taskRegistry.entries()).map(
      ([taskId, taskInfo]) => ({
        taskId,
        agent: taskInfo,
      })
    );
  }

  /**
   * Attach to an existing agent task
   */
  attachToTask(taskId: string): boolean {
    if (this.taskRegistry.has(taskId)) {
      console.log(Marked.parse(`**Attached to agent task: ${taskId}**`));
      return true;
    }
    console.log(
      Marked.parse(`**Task ${taskId} not found or already completed.**`)
    );
    return false;
  }

  /**
   * Generate human-readable task ID from initial input
   */
  private generateTaskId(initialInput: string): string {
    const words = initialInput
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 3);

    const wordPart = words.join("-") || "task";
    const epochSeconds = Math.floor(Date.now() / 1000);
    return `${epochSeconds}-${wordPart}`;
  }

  /**
   * Save session to file
   */
  private saveSession(
    taskId: string,
    taskInfo: TaskInfo,
    threads: any[]
  ): void {
    try {
      const sessionPath = path.join(this.sessionsDir, `${taskId}.json`);
      const session: ChatSession = {
        sessionId: taskId,
        knowhowMessageId: taskInfo.knowhowMessageId,
        knowhowTaskId: taskInfo.knowhowTaskId,
        taskId,
        agentName: taskInfo.agentName,
        initialInput: taskInfo.initialInput,
        status: taskInfo.status,
        startTime: taskInfo.startTime,
        endTime: taskInfo.endTime,
        totalCost: taskInfo.totalCost,
        threads,
        currentThread: 0,
        lastUpdated: Date.now(),
      };

      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    } catch (error) {
      console.error(`Error saving session ${taskId}:`, error);
    }
  }

  /**
   * Update existing session with new thread state
   */
  private updateSession(taskId: string, threads: any[]): void {
    try {
      const sessionPath = path.join(this.sessionsDir, `${taskId}.json`);
      if (fs.existsSync(sessionPath)) {
        const session: ChatSession = JSON.parse(
          fs.readFileSync(sessionPath, "utf8")
        );
        const taskInfo = this.taskRegistry.get(taskId);

        // Update session with current state
        session.threads = threads;
        session.lastUpdated = Date.now();
        if (taskInfo) {
          session.status = taskInfo.status;
          session.endTime = taskInfo.endTime;
          session.totalCost = taskInfo.totalCost;

          // Update Knowhow task fields if they exist in TaskInfo
          session.knowhowMessageId = taskInfo.knowhowMessageId;
          session.knowhowTaskId = taskInfo.knowhowTaskId;
        }

        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      }
    } catch (error) {
      console.error(`Error updating session ${taskId}:`, error);
    }
  }

  /**
   * Start an agent with an initial task (simplified version for now)
   */
  private async startAgent(
    selectedAgent: BaseAgent,
    initialInput: string,
    chatHistory: ChatInteraction[] = []
  ): Promise<{ result: boolean; finalOutput?: string }> {
    try {
      const { agent, taskId } = await this.setupAgent({
        agentName: selectedAgent.name,
        input: initialInput,
        chatHistory,
        run: false, // Don't run yet, we need to set up event listeners first
      });
      const result = await this.attachedAgentChatLoop(
        taskId,
        agent,
        initialInput
      );
      return result;
    } catch (error) {
      console.error("Error starting agent:", error);
      return { result: false, finalOutput: "Error starting agent" };
    }
  }

  async attachedAgentChatLoop(
    taskId: string,
    agent: BaseAgent,
    initialInput?: string
  ): Promise<{ result: boolean; finalOutput?: string }> {
    try {
      let done = false;
      let output = "Done";
      let agentFinalOutput: string | undefined;

      // Define available commands
      const commands = ["/pause", "/unpause", "/kill", "/detach", "/done"];
      const history: string[] = [];

      // Set up the event listener BEFORE starting the agent to avoid race condition
      let finished = false;
      const donePromise = new Promise<string>((resolve) => {
        agent.agentEvents.once(agent.eventTypes.done, (doneMsg) => {
          // Capture the agent's final output
          agentFinalOutput = doneMsg || "No response from the AI";
          finished = true;
          resolve("done");
        });
      });

      // Now start the agent if we have an initial input (this means we're starting, not just attaching)
      if (initialInput) {
        const taskInfo = this.taskRegistry.get(taskId);
        agent.call(taskInfo?.initialInput || initialInput);
      }

      let input =
        (await this.chatService?.getInput(
          `Enter command or message for ${agent.name}: `,
          commands
        )) || "";

      history.push(input);

      while (!done) {
        switch (input) {
          case "":
            if (finished) {
              output = "Agent has completed the task.";
              done = true;
            }
            break;
          case "/done":
            output = "Exited agent interaction.";
            done = true;
            break;
          case "/pause":
            await agent.pause();
            console.log("Agent paused.");
            break;
          case "/unpause":
            await agent.unpause();
            console.log("Agent unpaused.");
            break;
          case "/kill":
            await agent.kill();
            console.log("Agent terminated.");
            done = true;
            break;
          case "/detach":
            console.log("Detached from agent");
            return { result: true, finalOutput: agentFinalOutput };
          default:
            agent.addPendingUserMessage({
              role: "user",
              content: input,
            });
        }

        if (!done) {
          input = await this.chatService?.getInput(
            `Enter command or message for ${agent.name}: `,
            commands
          );
        }
      }

      // Update final task status and save session
      const finalTaskInfo = this.taskRegistry.get(taskId);
      if (finalTaskInfo) {
        if (finalTaskInfo.status === "running") {
          finalTaskInfo.status = "completed";
          // Ensure final cost is captured
          finalTaskInfo.totalCost = agent.getTotalCostUsd();
          finalTaskInfo.endTime = Date.now();
        }
      }
      return { result: true, finalOutput: agentFinalOutput };
    } catch (error) {
      console.error("Agent execution failed:", error);
      return { result: false, finalOutput: "Error during agent execution" };
    }
  }
}
