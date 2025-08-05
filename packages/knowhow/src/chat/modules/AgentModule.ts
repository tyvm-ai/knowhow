/**
 * Agent Chat Module - Handles agent interactions
 */
import * as fs from "fs";
import * as path from "path";

import { formatChatInput } from "../../chat";
import { BaseChatModule } from "./BaseChatModule";
import { services } from "../../services/index";
import { BaseAgent } from "../../agents/index";
import { ChatCommand, ChatMode, ChatContext } from "../types";
import { ChatInteraction } from "../../types";
import { Marked } from "../../utils/index";
import { TokenCompressor } from "../../processors/TokenCompressor";
import { ToolResponseCache } from "../../processors/ToolResponseCache";
import { CustomVariables, XmlToolCallProcessor } from "../../processors/index";
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
        active: false,
      },
    ];
  }

  async handleAgentCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      console.log(
        "Please specify an agent name. Use /agents to list available agents."
      );
      return;
    }

    const agentName = args[0];
    const allAgents = agents();

    try {
      if (allAgents && allAgents[agentName]) {
        // Set selected agent in context and enable agent mode
        const context = this.chatService?.getContext();
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

  async handleSessionsCommand(args: string[]): Promise<void> {
    try {
      // Get both running tasks and saved sessions
      const runningTasks = Array.from(this.taskRegistry.values());
      const savedSessions = await this.listAvailableSessions();

      if (runningTasks.length === 0 && savedSessions.length === 0) {
        console.log("No active tasks or saved sessions found.");
        return;
      }

      // Display unified table
      console.log("\n📋 Sessions & Tasks:");
      console.log("─".repeat(120));
      console.log(
        "ID".padEnd(25) +
          "Agent".padEnd(15) +
          "Status".padEnd(12) +
          "Type".padEnd(10) +
          "Time".padEnd(12) +
          "Cost".padEnd(8) +
          "Initial Input"
      );
      console.log("─".repeat(120));

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

        console.log(
          session.sessionId.padEnd(25) +
            session.agentName.padEnd(15) +
            session.status.padEnd(12) +
            "saved".padEnd(10) +
            lastUpdated.slice(-10).padEnd(12) + // Show just time portion
            cost.padEnd(8) +
            inputPreview
        );
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

        console.log(
          task.taskId.padEnd(25) +
            task.agentName.padEnd(15) +
            task.status.padEnd(12) +
            "running".padEnd(10) +
            elapsed.padEnd(12) +
            cost.padEnd(8) +
            inputPreview
        );
      });

      console.log("─".repeat(120));

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
  private async listAvailableSessions(): Promise<ChatSession[]> {
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

      await this.startAgent(selectedAgent, resumePrompt, []);
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
      const result = await this.startAgent(
        context.selectedAgent,
        input,
        context.chatHistory || []
      );
      return result;
    }
    return false;
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
    const timestamp = Date.now().toString().slice(-6);
    return `${wordPart}-${timestamp}`;
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
  ): Promise<boolean> {
    let done = false;
    let output = "Done";
    const taskId = this.generateTaskId(initialInput);

    try {
      // Create task info object
      const taskInfo: TaskInfo = {
        taskId,
        agentName: selectedAgent.name,
        agent: selectedAgent,
        initialInput,
        status: "running",
        startTime: Date.now(),
        totalCost: 0,
      };

      // Add to task registry
      this.taskRegistry.set(taskId, taskInfo);

      // Save initial session
      this.saveSession(taskId, taskInfo, []);

      // Set up session update listener
      selectedAgent.agentEvents.on("threadUpdate", (threadState) => {
        // Update task cost from agent's current total cost
        taskInfo.totalCost = selectedAgent.getTotalCostUsd();
        this.updateSession(taskId, threadState);
      });

      // Also listen for cost updates specifically
      selectedAgent.agentEvents.on("costUpdate", (currentCost) => {
        taskInfo.totalCost = currentCost;
        // Update session with new cost
        this.updateSession(taskId, selectedAgent.getThreads());
      });

      console.log(
        Marked.parse(
          `**Starting ${selectedAgent.name} with task ID: ${taskId}...**`
        )
      );
      console.log(Marked.parse(`**Task:** ${initialInput}`));

      // Initialize new task
      await selectedAgent.newTask();

      // Get context for plugins
      const context = this.chatService?.getContext();
      const plugins = context?.plugins || [];

      // Format the prompt with plugins and chat history
      const formattedPrompt = await formatChatInput(
        initialInput,
        plugins,
        chatHistory
      );

      // Start the agent with the formatted prompt
      selectedAgent.call(formattedPrompt);

      // Set up message processors like in original startAgent

      selectedAgent.messageProcessor.setProcessors("pre_call", [
        new ToolResponseCache(selectedAgent.tools).createProcessor(),
        new TokenCompressor(selectedAgent.tools).createProcessor((msg) =>
          Boolean(msg.role === "tool" && msg.tool_call_id)
        ),
        new CustomVariables(selectedAgent.tools).createProcessor(),
      ]);

      selectedAgent.messageProcessor.setProcessors("post_call", [
        new XmlToolCallProcessor().createProcessor(),
      ]);

      // Set up event listeners
      if (
        !selectedAgent.agentEvents.listenerCount(
          selectedAgent.eventTypes.toolUsed
        )
      ) {
        selectedAgent.agentEvents.on(
          selectedAgent.eventTypes.toolUsed,
          (responseMsg) => {
            console.log(
              ` 🔨 Tool used: ${JSON.stringify(responseMsg, null, 2)}`
            );
          }
        );
      }

      selectedAgent.agentEvents.once(
        selectedAgent.eventTypes.done,
        (doneMsg) => {
          console.log("Agent has finished.");
          // Update task info
          const taskInfo = this.taskRegistry.get(taskId);
          if (taskInfo) {
            taskInfo.status = "completed";
            // Update final cost from agent
            taskInfo.totalCost = selectedAgent.getTotalCostUsd();
            // Update session with final state
            this.updateSession(taskId, selectedAgent.getThreads());
            taskInfo.endTime = Date.now();
          }
          done = true;
          output = doneMsg || "No response from the AI";
          console.log(Marked.parse(output));
        }
      );

      return await this.attachedAgentChatLoop(taskId, selectedAgent);
    } catch (error) {
      console.error("Agent setup failed:", error);
      this.taskRegistry.delete(taskId);
      return false;
    }
  }

  async attachedAgentChatLoop(taskId: string, selectedAgent: BaseAgent) {
    try {
      let done = false;
      let output = "Done";

      // Define available commands
      const commands = ["pause", "unpause", "kill", "detach"];
      const history: string[] = [];

      let input =
        (await this.chatService?.getInput(
          `Enter command or message for ${selectedAgent.name}: `,
          commands
        )) || "";

      history.push(input);

      const donePromise = new Promise<string>((resolve) => {
        selectedAgent.agentEvents.on(selectedAgent.eventTypes.done, () => {
          done = true;
          resolve("done");
        });
      });

      while (!done) {
        switch (input) {
          case "":
            break;
          case "done":
            output = "Exited agent interaction.";
            done = true;
            break;
          case "pause":
            await selectedAgent.pause();
            console.log("Agent paused.");
            break;
          case "unpause":
            await selectedAgent.unpause();
            console.log("Agent unpaused.");
            break;
          case "kill":
            await selectedAgent.kill();
            console.log("Agent terminated.");
            done = true;
            break;
          case "detach":
            console.log("Detached from agent");
            return true;
          default:
            selectedAgent.addPendingUserMessage({
              role: "user",
              content: input,
            });
        }

        if (!done) {
          input = await this.chatService?.getInput(
            `Enter command or message for ${selectedAgent.name}: `,
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
          finalTaskInfo.totalCost = selectedAgent.getTotalCostUsd();
          finalTaskInfo.endTime = Date.now();
        }
      }

      return true;
    } catch (error) {
      console.error("Agent execution failed:", error);
      this.taskRegistry.delete(taskId);
      return false;
    }
  }
}
