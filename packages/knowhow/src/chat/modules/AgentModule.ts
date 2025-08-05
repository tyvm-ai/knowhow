/**
 * Agent Chat Module - Handles agent interactions
 */
import * as fs from "fs";
import * as path from "path";

import { formatChatInput } from "../../chat.js";
import { BaseChatModule } from "./BaseChatModule.js";
import { services } from "../../services/index.js";
import { BaseAgent } from "../../agents/index.js";
import { ChatCommand, ChatMode, ChatContext } from "../types.js";
import { ChatInteraction } from "../../types.js";
import { Marked } from "../../utils/index.js";
import { TokenCompressor } from "../../processors/TokenCompressor.js";
import { ToolResponseCache } from "../../processors/ToolResponseCache.js";
import {
  CustomVariables,
  XmlToolCallProcessor,
} from "../../processors/index.js";
import { TaskInfo, ChatSession } from "../types.js";
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
        description: "Attach to an existing agent task",
        handler: this.handleAttachCommand.bind(this),
      },
      {
        name: "tasks",
        description: "List active agent tasks",
        handler: this.handleTasksCommand.bind(this),
      },
      {
        name: "sessions",
        description: "List saved sessions",
        handler: this.handleSessionsCommand.bind(this),
      },
      {
        name: "resume",
        description: "Resume a saved session",
        handler: this.handleResumeCommand.bind(this),
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
          context.mode = "agent";
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
      // Show active tasks
      const activeTasks = this.getActiveTasks();
      if (activeTasks.length === 0) {
        console.log("No active agent tasks found.");
        return;
      }

      console.log("Active agent tasks:");
      activeTasks.forEach(({ taskId, agent }) => {
        console.log(`  ${taskId}: ${agent.agentName}`);
      });
      return;
    }

    const taskId = args[0];
    this.attachToTask(taskId);
  }

  async handleTasksCommand(args: string[]): Promise<void> {
    const allTasks = Array.from(this.taskRegistry.values());
    if (allTasks.length === 0) {
      console.log("No agent tasks found.");
      return;
    }

    if (args.length === 0) {
      // Show task table and provide interactive selection
      this.displayTaskTable(allTasks);

      // Get task IDs for autocomplete
      const taskIds = allTasks.map((task) => task.taskId);

      // Interactive selection
      const selectedTaskId = await this.chatService?.getInput(
        "Select a task to attach to (or press Enter to skip): ",
        taskIds
      );

      if (
        selectedTaskId &&
        selectedTaskId.trim() &&
        taskIds.includes(selectedTaskId.trim())
      ) {
        this.attachToTask(selectedTaskId.trim());
      }
      return;
    }

    // Handle specific task ID argument
    const taskId = args[0];
    if (this.taskRegistry.has(taskId)) {
      const taskInfo = this.taskRegistry.get(taskId)!;
      this.displaySingleTask(taskInfo);
    } else {
      console.log(`Task "${taskId}" not found.`);
    }
  }

  /**
   * Display task table with full metadata
   */
  private displayTaskTable(tasks: TaskInfo[]): void {
    console.log("\n📋 Task Registry:");
    console.log("─".repeat(100));
    console.log(
      "Task ID".padEnd(20) +
        "Agent".padEnd(15) +
        "Status".padEnd(12) +
        "Elapsed".padEnd(10) +
        "Cost".padEnd(8) +
        "Initial Input"
    );
    console.log("─".repeat(100));

    tasks.forEach((task) => {
      const elapsed = task.endTime
        ? `${Math.round((task.endTime - task.startTime) / 1000)}s`
        : `${Math.round((Date.now() - task.startTime) / 1000)}s`;
      const cost = `$${task.totalCost.toFixed(3)}`;
      const preview =
        task.initialInput.length > 35
          ? task.initialInput.substring(0, 32) + "..."
          : task.initialInput;

      console.log(
        task.taskId.padEnd(20) +
          task.agentName.padEnd(15) +
          task.status.padEnd(12) +
          elapsed.padEnd(10) +
          cost.padEnd(8) +
          preview
      );
    });
    console.log("─".repeat(100));

    // Also output JSON for analysis
    const taskData = tasks.map((task) => ({
      taskId: task.taskId,
      agentName: task.agentName,
      status: task.status,
      elapsedTimeMs: task.endTime
        ? task.endTime - task.startTime
        : Date.now() - task.startTime,
      totalCost: task.totalCost,
      initialInput: task.initialInput,
    }));

    console.log("\n📊 Task Data (JSON):");
    console.log(JSON.stringify(taskData, null, 2));
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

  async handleTasksCommandOld(args: string[]): Promise<void> {
    const activeTasks = this.getActiveTasks();
    if (activeTasks.length === 0) {
      console.log("No active agent tasks found.");
      return;
    }

    console.log("Active agent tasks:");
    activeTasks.forEach(({ taskId, agent }) => {
      console.log(`  ${taskId}: ${agent.agentName}`);
    });
  }

  async handleAgentsCommand(args: string[]): Promise<void> {
    try {
      const { agents } = await import("../../agents/index.js");
      const allAgents = agents();

      if (allAgents && Object.keys(allAgents).length > 0) {
        const agentNames = Object.keys(allAgents);

        console.log("Available agents:");
        Object.entries(allAgents).forEach(([name, agent]: [string, any]) => {
          console.log(`  - ${name}: ${agent.description || "No description"}`);
        });

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
      const sessionFiles = fs
        .readdirSync(this.sessionsDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.replace(".json", ""));

      if (sessionFiles.length === 0) {
        console.log("No saved sessions found.");
        return;
      }

      console.log("Saved sessions:");
      for (const sessionId of sessionFiles) {
        try {
          const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
          const sessionData: ChatSession = JSON.parse(
            fs.readFileSync(sessionPath, "utf8")
          );
          const lastUpdated = new Date(
            sessionData.lastUpdated
          ).toLocaleString();
          const inputPreview =
            sessionData.initialInput && sessionData.initialInput.length > 100
              ? sessionData.initialInput.substring(0, 100) + "..."
              : sessionData.initialInput || "[No initial input]";
          console.log(
            `  ${sessionId}: ${sessionData.agentName} - ${sessionData.status} (${lastUpdated}) - "${inputPreview}"`
          );
        } catch (error) {
          console.log(`  ${sessionId}: [Error reading session]`);
        }
      }
    } catch (error) {
      console.error("Error listing sessions:", error);
    }
  }

  async handleResumeCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      // List available sessions for selection
      const sessions = await this.listAvailableSessions();
      if (sessions.length === 0) {
        console.log("No saved sessions found.");
        return;
      }

      console.log("\n💾 Available Sessions:");
      console.log("─".repeat(80));
      console.log(
        "Session ID".padEnd(25) +
          "Agent".padEnd(15) +
          "Status".padEnd(12) +
          "Last Updated"
      );
      console.log("─".repeat(80));

      sessions.forEach((session) => {
        const lastUpdated = new Date(session.lastUpdated).toLocaleString();
        console.log(
          session.sessionId.padEnd(25) +
            session.agentName.padEnd(15) +
            session.status.padEnd(12) +
            lastUpdated
        );
      });
      console.log("─".repeat(80));

      // Interactive selection
      const sessionIds = sessions.map((s) => s.sessionId);
      const selectedSessionId = await this.chatService?.getInput(
        "Select a session to resume (or press Enter to skip): ",
        sessionIds
      );

      if (
        selectedSessionId &&
        selectedSessionId.trim() &&
        sessionIds.includes(selectedSessionId.trim())
      ) {
        await this.resumeSession(selectedSessionId.trim());
      }
      return;
    }

    // Resume specific session
    const sessionId = args[0];
    await this.resumeSession(sessionId);
  }

  /**
   * List available session files
   */
  private async listAvailableSessions(): Promise<ChatSession[]> {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessionFiles = files.filter((f) => f.endsWith(".json"));

      const sessions: ChatSession[] = [];
      for (const file of sessionFiles) {
        try {
          const filePath = path.join(this.sessionsDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const session: ChatSession = JSON.parse(content);
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
  private async resumeSession(sessionId: string): Promise<void> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
      const content = fs.readFileSync(sessionPath, "utf-8");
      const session: ChatSession = JSON.parse(content);
      const lastThread = session.threads[session.threads.length - 1];

      console.log(`\n🔄 Resuming session: ${sessionId}`);
      console.log(`Agent: ${session.agentName}`);
      console.log(`Original task: ${session.initialInput}`);
      console.log(`Status: ${session.status}`);

      // Create resume prompt
      const resumePrompt = `You are resuming a previously started task. Here's the context:
ORIGINAL REQUEST:
${session.initialInput}

LAST Progress State:
${JSON.stringify(lastThread)}

Please continue from where you left off and complete the original request.`;

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
    if (context.mode === "agent" && context.selectedAgent) {
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
      const { formatChatInput } = await import("../../chat.js");
      const formattedPrompt = await formatChatInput(
        initialInput,
        plugins,
        chatHistory
      );

      // Start the agent with the formatted prompt
      selectedAgent.call(formattedPrompt);

      // Set up message processors like in original startAgent
      const { ToolResponseCache } = await import(
        "../../processors/ToolResponseCache.js"
      );
      const { TokenCompressor } = await import(
        "../../processors/TokenCompressor.js"
      );
      const { CustomVariables, XmlToolCallProcessor } = await import(
        "../../processors/index.js"
      );

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
          input = await Promise.race([
            this.chatService?.getInput(
              `Enter command or message for ${selectedAgent.name}: `,
              commands
            ) || Promise.resolve(""),
            donePromise,
          ]);
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
