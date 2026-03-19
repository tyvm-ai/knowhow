/**
 * Agent Chat Module - Handles agent interactions
 */
import { ConsoleRenderer, AgentRenderer } from "../renderer";
import {
  SessionManager,
  TaskRegistry,
  SyncedAgentWatcher,
  SyncerService,
} from "../../services/index";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { BaseChatModule } from "./BaseChatModule";
import { services } from "../../services/index";
import { BaseAgent } from "../../agents/index";
import { ChatCommand, ChatMode, ChatContext, ChatService } from "../types";
import { Message } from "../../clients/types";
import { ChatInteraction } from "../../types";
import { Marked } from "../../utils/index";
import { TokenCompressor } from "../../processors/TokenCompressor";
import { ToolResponseCache } from "../../processors/ToolResponseCache";
import {
  CustomVariables,
  XmlToolCallProcessor,
  HarmonyToolProcessor,
  Base64ImageProcessor,
} from "../../processors/index";
import { TaskInfo } from "../types";
import { createAgent, agentConstructors, AgentName, agents } from "../../agents";
import { ToolCallEvent } from "../../agents/base/base";
import { $Command } from "@aws-sdk/client-s3";
import { KnowhowSimpleClient } from "../../services/KnowhowClient";

export class AgentModule extends BaseChatModule {
  name = "agent";
  description = "Agent interaction functionality";

  // Service instances for task management, session management, and synchronization
  private taskRegistry: TaskRegistry;
  private sessionManager: SessionManager;
  private syncer: SyncerService;
  /** Timestamp when this process started - used to filter sessions */
  private processStartTime: number = Date.now();
  /** Currently attached agent task ID */
  private activeAgentTaskId: string | undefined;
  /** Currently active synced agent watcher (for FS or Web agents) */
  private activeSyncedWatcher: SyncedAgentWatcher | undefined;

  constructor() {
    super();
    this.taskRegistry = new TaskRegistry();
    this.sessionManager = new SessionManager();
    this.syncer = new SyncerService();
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

  /**
   * Get the current renderer from the chat context, falling back to a ConsoleRenderer.
   */
  private get renderer(): AgentRenderer {
    return (this.chatService?.getContext()?.renderer as AgentRenderer) ?? new ConsoleRenderer();
  }

  async initialize(service: ChatService): Promise<void> {
    await super.initialize(service);

    // Set up plugin log event handler
    const Events = services().Events;
    Events.on(Events.eventTypes.pluginLog, (logEvent: any) => {
      // Forward plugin logs to renderer for all active tasks
      const activeTasks = this.taskRegistry.getAll();
      activeTasks.forEach((task) => {
        this.renderer.render({
          type: "log",
          taskId: task.taskId,
          agentName: logEvent.source,
          message: logEvent.message,
          level: logEvent.level || "info",
          timestamp: logEvent.timestamp || new Date().toISOString(),
        });
      });
    });

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
          this.chatService.disableMode("agent");
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
          const selectedAgent = allAgents[agentName];
          context.selectedAgent = selectedAgent;
          context.agentMode = true;
          context.currentAgent = agentName;
          // Update context's model/provider to reflect the agent's settings
          // so /model and /provider commands show accurate information
          context.currentModel = selectedAgent.getModel();
          context.currentProvider = selectedAgent.getProvider();
          this.chatService.setMode("agent");
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


  /**
   * Get the task registry for CLI access
   */
  public getTaskRegistry(): TaskRegistry {
    return this.taskRegistry;
  }

  /**
   * Get the session manager
   */
  public getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the current renderer from the chat context, falling back to a ConsoleRenderer.
   */
  public getRenderer(): AgentRenderer {
    return this.renderer;
  }

  /**
   * Get the currently active synced watcher
   */
  public getActiveSyncedWatcher(): SyncedAgentWatcher | undefined {
    return this.activeSyncedWatcher;
  }

  /**
   * Set the currently active synced watcher
   */
  public setActiveSyncedWatcher(w: SyncedAgentWatcher | undefined): void {
    this.activeSyncedWatcher = w;
  }

  /**
   * Get the currently active agent task ID
   */
  public getActiveAgentTaskId(): string | undefined {
    return this.activeAgentTaskId;
  }

  /**
   * Set the currently active agent task ID
   */
  public setActiveAgentTaskId(id: string | undefined): void {
    this.activeAgentTaskId = id;
  }

  /**
   * List available agents and optionally select one interactively
   */
  async handleAgentsCommand(args: string[]): Promise<void> {
    try {
      const allAgents = agents();

      if (allAgents && Object.keys(allAgents).length > 0) {
        const agentNames = Object.keys(allAgents);

        console.log("\nAvailable agents:");
        Object.entries(allAgents).forEach(([name, agent]: [string, any]) => {
          console.log(`  - ${name}: ${(agent as any).description || "No description"}`);
        });
        console.log("─".repeat(80), "\n");

        const selectedAgent = await this.chatService?.getInput(
          "Select an agent to start: ",
          agentNames
        );

        if (selectedAgent && selectedAgent.trim() && agentNames.includes(selectedAgent.trim())) {
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

  /**
   * Get the process start time
   */
  public getProcessStartTime(): number {
    return this.processStartTime;
  }

  /**
   * Resume a session from saved state
   */
  public async resumeSession(
    sessionId: string,
    resumeReason?: string
  ): Promise<void> {
    try {
      const session = this.sessionManager.loadSession(sessionId);
      if (!session) {
        console.error(`Session ${sessionId} not found.`);
        return;
      }
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

      console.log("🚀 Session resuming...");
      const context = this.chatService?.getContext();
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
    syncFs?: boolean;
    existingKnowhowTaskId?: string;
    provider?: string;
    model?: string;
    maxTimeLimit?: number; // in minutes
    maxSpendLimit?: number; // in dollars
    chatHistory?: ChatInteraction[];
    run?: boolean; // whether to run immediately
    taskId?: string; // optional pre-generated taskId
  }) {
    if (!agentConstructors[options.agentName as AgentName]) {
      throw new Error(
        `Agent "${options.agentName}" not found. Available agents: ${Object.keys(agentConstructors).join(", ")}`
      );
    }

    const { input, chatHistory = [], agentName } = options;
    const agentContext = services().Agents.getAgentContext();
    const agent = createAgent(options.agentName as AgentName, agentContext) as BaseAgent;

    let done = false;
    let output = "Done";
    const taskId = options.taskId || this.sessionManager.generateTaskId(input);
    let knowhowTaskId: string | undefined;

    try {
      // Get context for plugins
      const context = this.chatService?.getContext();
      const plugins = context?.plugins || [];

      // Format the prompt with plugins and chat history
      const formattedPrompt = await this.chatService.formatChatInput(
        input,
        plugins,
        chatHistory
      );

      // Create task info object
      let taskInfo: TaskInfo = {
        taskId,
        knowhowMessageId: options.messageId,
        knowhowTaskId: options.existingKnowhowTaskId, // Use existing or will be set after creating chat task
        agentName,
        agent,
        initialInput: input,
        formattedPrompt,
        status: "running",
        startTime: Date.now(),
        totalCost: 0,
      };

      // Add to task registry
      this.taskRegistry.register(taskId, taskInfo);

      // Save initial session
      this.saveSession(taskId, taskInfo, []);

      // Reset sync services before setting up new task (removes old listeners)
      this.syncer.reset();

      // Create sync task (SyncerService decides web vs fs internally)
      const syncTaskId = await this.syncer.createTask({
        taskId,
        prompt: input,
        messageId: options.messageId,
        syncFs: options.syncFs,
        existingKnowhowTaskId: options.existingKnowhowTaskId,
        agentName,
      });

      // Update TaskInfo with the sync task ID
      const webTaskId = this.syncer.getCreatedWebTaskId();
      knowhowTaskId = webTaskId;
      taskInfo.knowhowTaskId = webTaskId || syncTaskId;
      this.taskRegistry.register(taskId, taskInfo);

      // Wire up event listeners on the agent
      await this.syncer.setupAgentSync(agent, syncTaskId);

      // Set up session update listener
      const threadUpdateHandler = async (threadState: any) => {
        this.updateSession(taskId, threadState);
        taskInfo.totalCost = agent.getTotalCostUsd();
      };
      agent.agentEvents.on(agent.eventTypes.threadUpdate, threadUpdateHandler);

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

      // Set up message processors like in original startAgent

      // Register an override for askHuman to use CLI input method
      // This keeps the askHuman tool CLI-agnostic while enabling CLI-specific behavior
      // through the override system, achieving better separation of concerns
      agent.tools.registerOverride(
        "askHuman",
        async (originalArgs: any[], originalTool: any) => {
          const question = originalArgs[0];

          // Use CLI-specific input method from CliChatService
          const chatService = this.chatService;
          if (!chatService) {
            throw new Error("ChatService not available in tools context");
          }
          console.log("AI has asked: ");
          console.log(Marked.parse(question), "\n");
          return await chatService.getInput("response: ");
        },
        10 // Priority level
      );

      const caching = [
        new ToolResponseCache(agent.tools).createProcessor(),
        new TokenCompressor(agent.tools).createProcessor((msg) =>
          Boolean(msg.role === "tool" && msg.tool_call_id)
        ),
      ];

      agent.messageProcessor.setProcessors("pre_call", [
        new Base64ImageProcessor(agent.tools).createProcessor(),
        ...caching,
        new CustomVariables(agent.tools).createProcessor(),
      ]);

      agent.messageProcessor.setProcessors("post_call", [
        new XmlToolCallProcessor().createProcessor(),
        new HarmonyToolProcessor().createProcessor(),
      ]);

      agent.messageProcessor.setProcessors("post_tools", [
        new Base64ImageProcessor(agent.tools).createProcessor(),
        ...caching,
      ]);

      // Set up event listeners
      // Each task gets a fresh agent instance (via createAgent), so no stale listeners exist.
      const toolCallHandler = (responseMsg: ToolCallEvent) => {
        this.renderer.render({
          type: "toolCall",
          taskId,
          agentName: agent.name,
          toolCall: responseMsg.toolCall,
        });
      };
      const toolUsedHandler = (responseMsg: ToolCallEvent) => {
        this.renderer.render({
          type: "toolResult",
          taskId,
          agentName: agent.name,
          toolCall: responseMsg.toolCall,
          result: responseMsg.functionResp,
        });
      };
      const agentLogHandler = (logData: any) => {
        this.renderer.render({
          type: "log",
          taskId: taskId,
          agentName: logData.agentName,
          message: logData.message,
          level: logData.level,
          timestamp: logData.timestamp,
        });
      };
      const agentStatusHandler = (statusData: any) => {
        this.renderer.render({
          type: "agentStatus",
          taskId: taskId,
          agentName: statusData.agentName,
          statusMessage: statusData.statusMessage,
          details: statusData.details,
          timestamp: statusData.timestamp,
        });
      };
      const agentSayHandler = (sayData: any) => {
        this.renderer.render({
          type: "agentMessage",
          taskId: taskId,
          agentName: agent.name,
          message: sayData.message,
          role: "assistant",
        });
      };

      agent.agentEvents.on(agent.eventTypes.toolCall, toolCallHandler);
      agent.agentEvents.on(agent.eventTypes.toolUsed, toolUsedHandler);
      agent.agentEvents.on(agent.eventTypes.agentLog, agentLogHandler);
      agent.agentEvents.on(agent.eventTypes.agentStatus, agentStatusHandler);
      agent.agentEvents.on(agent.eventTypes.agentSay, agentSayHandler);

      const taskCompleted = new Promise<string>((resolve) => {
        agent.agentEvents.once(agent.eventTypes.done, async (doneMsg) => {
          console.log("🎯 [AgentModule] Task Completed");
          done = true;
          output = doneMsg || "No response from the AI";
          // Remove threadUpdate listener to prevent cost sharing across tasks
          agent.agentEvents.removeListener(
            agent.eventTypes.threadUpdate,
            threadUpdateHandler
          );
          // Remove task-specific listeners so they don't fire for the next task
          agent.agentEvents.removeListener(agent.eventTypes.toolCall, toolCallHandler);
          agent.agentEvents.removeListener(agent.eventTypes.toolUsed, toolUsedHandler);
          agent.agentEvents.removeListener(agent.eventTypes.agentLog, agentLogHandler);
          agent.agentEvents.removeListener(agent.eventTypes.agentStatus, agentStatusHandler);
          agent.agentEvents.removeListener(agent.eventTypes.agentSay, agentSayHandler);
          // Update task info
          taskInfo = this.taskRegistry.get(taskId);

          // Wait for AgentSync to finish before resolving
          await this.syncer.waitForFinalization();

          if (taskInfo) {
            taskInfo.status = "completed";
            // Update final cost from agent
            taskInfo.totalCost = agent.getTotalCostUsd();
            // Update session with final state
            this.updateSession(taskId, agent.getThreads());
            taskInfo.endTime = Date.now();
          }

          console.log(Marked.parse(output));
          console.log("🎯 [AgentModule] Task Complete");
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

      return {
        agent,
        taskId,
        formattedPrompt,
        initialInput: input,
        taskCompleted,
      };
    } catch (error) {
      console.error("Agent setup failed:", error);
      this.taskRegistry.delete(taskId);
    }
  }

  public async loadThreadsForTask(taskId: string, messageId?: string) {
    const resumeTaskId: string = taskId;
    const localMetadataPath = path.join(
      ".knowhow",
      "processes",
      "agents",
      resumeTaskId,
      "metadata.json"
    );

    let threads: Message[][] = [];

    // Try local FS first
    if (!messageId && fs.existsSync(localMetadataPath)) {
      try {
        const raw = await fsPromises.readFile(localMetadataPath, "utf-8");
        const metadata = JSON.parse(raw);
        threads = metadata.threads || [];
        console.log(`📁 Loaded threads from local FS: ${localMetadataPath}`);
      } catch (e) {
        console.warn(`⚠️ Failed to parse local metadata: ${e.message}`);
      }
    } else {
      // Try remote via KnowhowSimpleClient
      try {
        const client = new KnowhowSimpleClient();
        threads = await client.getTaskThreads(resumeTaskId);
        console.log(`🌐 Loaded threads from remote for task: ${resumeTaskId}`);
      } catch (e) {
        console.warn(`⚠️ Could not load threads from remote: ${e.message}`);
      }
    }

    return threads;
  }

  /**
   * Resume an agent from a set of existing message threads
   * Used by the CLI --resume flag to continue crashed/failed tasks
   */
  public async resumeFromMessages(options: {
    agentName: string;
    input: string;
    threads: Message[][];
    messageId?: string;
    taskId?: string;
  }): Promise<{ taskCompleted: Promise<string> }> {
    const { agentName, input, threads, messageId, taskId } = options;

    // Try to extract the original request from the first user message in threads
    let originalRequest = "";
    if (threads && threads.length > 0) {
      const firstThread = threads[0];
      if (Array.isArray(firstThread)) {
        const firstUserMsg = firstThread.find(
          (m: any) => m.role === "user" && m.content
        );
        if (firstUserMsg) {
          originalRequest =
            typeof firstUserMsg.content === "string"
              ? firstUserMsg.content
              : JSON.stringify(firstUserMsg.content);
        }
      }
    }

    // Build the resume prompt
    const resumePrompt = [
      "You are resuming a previously started task.",
      originalRequest ? `ORIGINAL REQUEST: ${originalRequest}` : "",
      "Please continue from where you left off.",
      input ? input : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Flatten threads into a single messages array for the agent
    const lastThread =
      threads && threads.length > 0 ? threads[threads.length - 1] : [];
    const resumeMessages = [...lastThread];

    // find last user message index
    const resumeIndex = lastThread
      .reverse()
      .findIndex((e) => e.role === "user" && typeof e.content === "string");

    if (resumeIndex === -1) {
      resumeMessages.push({
        role: "user",
        content: resumePrompt,
      });
    } else {
      const actualIndex = lastThread.length - 1 - resumeIndex;
      const lastUserMessage = resumeMessages[actualIndex];
      lastUserMessage.content += `\n\n<Workflow>[RESUME CONTEXT]: ${resumePrompt}</Workflow>`;
    }

    const result = await this.setupAgent({
      agentName,
      input: resumePrompt,
      messageId,
      existingKnowhowTaskId: taskId,
      run: false,
    });

    // Start agent with prior messages as context
    result.agent.call(resumePrompt, resumeMessages);

    return { taskCompleted: result.taskCompleted };
  }

  /**
   * Get list of active agent tasks
   */
  getActiveTasks(): { taskId: string; agent: TaskInfo }[] {
    return Array.from(this.taskRegistry.getEntries()).map(
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
   * Save session to file
   */
  private saveSession(
    taskId: string,
    taskInfo: TaskInfo,
    threads: any[]
  ): void {
    this.sessionManager.saveSession(taskId, taskInfo, threads);
  }

  /**
   * Update existing session with new thread state
   */
  private updateSession(taskId: string, threads: any[]): void {
    const taskInfo = this.taskRegistry.get(taskId);
    this.sessionManager.updateSession(taskId, taskInfo, threads);
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
      const { agent, taskId, formattedPrompt } = await this.setupAgent({
        agentName: selectedAgent.name,
        input: initialInput,
        chatHistory,
        run: false, // Don't run yet, we need to set up event listeners first
      });
      const result = await this.attachedAgentChatLoop(
        taskId,
        agent,
        formattedPrompt
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
      // Set mode to agent:attached so custom commands are available
      if (this.chatService) {
        this.chatService.setMode("agent:attached");
      }

      // Track the active agent task for filtered rendering
      this.activeAgentTaskId = taskId;
      this.renderer.setActiveTaskId(taskId);
      const context = this.chatService?.getContext();
      if (context) context.activeAgentTaskId = taskId;

      // Get mode-specific commands for autocomplete
      const modeCommands =
        this.chatService
          ?.getCommandsForMode("agent:attached")
          .map((cmd) => `/${cmd.name}`) || [];

      const commands = [
        ...modeCommands,
        "/pause",
        "/unpause",
        "/kill",
        "/detach",
        "/done",
      ];
      const history: string[] = [];

      // Set up the event listener BEFORE starting the agent to avoid race condition
      let finished = false;
      const donePromise = new Promise<string>((resolve) => {
        agent.agentEvents.once(agent.eventTypes.done, (doneMsg) => {
          // Capture the agent's final output
          agentFinalOutput = doneMsg || "No response from the AI";
          console.log("Finished", taskId, `$${agent.getTotalCostUsd()}`);
          finished = true;
          resolve("done");
        });
      });

      // Now start the agent if we have an initial input (this means we're starting, not just attaching)
      if (initialInput) {
        const taskInfo = this.taskRegistry.get(taskId);
        agent.call(
          taskInfo?.formattedPrompt || taskInfo?.initialInput || initialInput
        );
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
            // Reset mode back to default when detaching
            if (this.chatService) {
              this.chatService.setMode("default");
            }
            // Stop any active synced watcher
            if (this.activeSyncedWatcher) {
              this.activeSyncedWatcher.stopWatching();
              this.activeSyncedWatcher = undefined;
            }
            // Clear active agent tracking so other agents' logs don't pollute output
            this.activeAgentTaskId = undefined;
            this.renderer.setActiveTaskId(undefined);
            if (context) context.activeAgentTaskId = undefined;
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

      // Reset mode back to default when exiting loop
      if (this.chatService) {
        this.chatService.setMode("default");
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

  /**
   * Interactive chat loop for an attached synced watcher (FS or Web agent).
   * Routes user input to watcher.sendMessage() and slash-commands to
   * watcher.pause() / unpause() / kill().
   */
  public async startAttachedWatcherLoop(
    taskId: string,
    watcher: SyncedAgentWatcher
  ): Promise<void> {
    // Set mode so /logs, /detach etc. are available
    if (this.chatService) {
      this.chatService.setMode("agent:attached");
    }

    this.activeAgentTaskId = taskId;
    this.renderer.setActiveTaskId(taskId);
    const context = this.chatService?.getContext();
    if (context) context.activeAgentTaskId = taskId;

    const modeCommands =
      this.chatService
        ?.getCommandsForMode("agent:attached")
        .map((cmd) => `/${cmd.name}`) || [];
    const commands = [
      ...modeCommands,
      "/pause",
      "/unpause",
      "/kill",
      "/detach",
      "/done",
    ];

    let done = false;
    while (!done) {
      let input: string;
      try {
        input =
          (await this.chatService?.getInput(
            `[${watcher.agentName}] Send message or command: `,
            commands
          )) || "";
      } catch {
        // EOF / stream closed — detach gracefully
        break;
      }

      switch (input.trim()) {
        case "/done":
        case "/detach":
          done = true;
          break;
        case "/pause":
          await watcher.pause();
          break;
        case "/unpause":
          await watcher.unpause();
          break;
        case "/kill":
          await watcher.kill();
          done = true;
          break;
        case "":
          // empty input — just loop
          break;
        default:
          await watcher.sendMessage(input.trim());
          console.log(`📨 Message sent to ${watcher.agentName}`);
      }
    }

    // Reset state on exit
    watcher.stopWatching();
    this.activeSyncedWatcher = undefined;
    this.activeAgentTaskId = undefined;
    this.renderer.setActiveTaskId(undefined);
    if (context) context.activeAgentTaskId = undefined;
    if (this.chatService) this.chatService.setMode("default");
    console.log(`🔌 Detached from ${watcher.agentName} (${taskId})`);
  }
}
