import { EventEmitter } from "events";
import {
  GenericClient,
  Message,
  OutputMessage,
  Tool,
  ToolCall,
} from "../../clients/types";
import { IAgent } from "../interface";
import { ToolsService } from "../../services/Tools";
import {
  mcpToolName,
  replaceEscapedNewLines,
  restoreEscapedNewLines,
} from "../../utils";
import { EventService } from "../../services/EventService";
import { AIClient, Clients } from "../../clients";
import { Models } from "../../ai";
import { MessageProcessor } from "../../services/MessageProcessor";

export { Message, Tool, ToolCall };
export interface ModelPreference {
  model: string;
  provider: keyof typeof Clients.clients;
}

export interface AgentContext {
  Tools?: ToolsService;
  Events?: EventService;
  messageProcessor?: MessageProcessor;
  Clients?: AIClient;
}

export abstract class BaseAgent implements IAgent {
  abstract name: string;
  abstract description: string;

  private status = "in_progress";
  private lastHealthCheckTime: number = 0;
  protected provider = "openai";
  protected modelName: string = Models.openai.GPT_4o;
  protected client: null | GenericClient = null;
  protected modelPreferences: ModelPreference[] = [];
  protected currentModelPreferenceIndex = 0;
  protected easyFinalAnswer = false;
  protected requiredToolNames = ["finalAnswer"];
  protected maxTurns: number | null = null;
  protected maxSpend: number | null = null;
  protected maxRunTimeMs: number | null = null;
  protected startTimeMs: number | null = null;
  protected turnCount = 0;
  protected totalCostUsd = 0;
  protected currentThread = 0;
  protected threads = [] as Message[][];
  protected pendingUserMessages = [] as Message[];
  protected taskBreakdown = "";
  protected summaries = [] as string[];
  protected currentTaskId: string | null = null;

  public agentEvents = new EventEmitter();
  public eventTypes = {
    newThread: "new_thread",
    threadUpdate: "thread_update",
    costUpdate: "cost_update",
    toolUsed: "tool_used",
    done: "done",
    pause: "pause",
    kill: "kill",
    unpause: "unpause",
  };
  public tools: ToolsService;
  public events: EventService;
  public messageProcessor: MessageProcessor;
  public clientService: AIClient;

  disabledTools = [];

  constructor(context: AgentContext) {
    this.tools = context.Tools;
    this.events = context.Events;
    this.messageProcessor = context.messageProcessor || new MessageProcessor();
    this.clientService = context.Clients || Clients;

    if (!this.tools) {
      throw new Error("ToolsService is required for BaseAgent");
    }

    if (!this.events) {
      throw new Error("EventService is required for BaseAgent");
    }

    // Subscribe to "agent:msg" events for dynamic context loading
    this.events.on("agent:msg", (eventData: any) => {
      const message = {
        role: "user",
        content: JSON.stringify(eventData),
      } as Message;
      this.addPendingUserMessage(message);
    });
  }

  setMaxTurns(maxTurns: number | null) {
    this.maxTurns = maxTurns;
  }

  setMaxSpend(maxSpend: number | null) {
    this.maxSpend = maxSpend;
  }

  setMaxRunTime(maxRunTimeMs: number | null) {
    this.maxRunTimeMs = maxRunTimeMs;
  }

  newTask(taskId?: string) {
    this.currentThread = 0;
    this.threads = [];
    this.taskBreakdown = "";
    this.summaries = [];
    this.totalCostUsd = 0;
    this.status = "in_progress";
    this.turnCount = 0;
    this.startTimeMs = Date.now();
    this.currentTaskId = taskId || this.startTimeMs.toString();

    // Emit event for plugin integration
    const id = taskId || this.startTimeMs.toString();
    this.events.emit("agent:newTask", {
      taskId: id,
    });
  }

  register() {
    this.events.registerAgent(this);
  }

  setModelPreferences(value: ModelPreference[]) {
    this.modelPreferences = value;
    if (value.length) {
      this.updatePreferences(value[0]);
    }
  }

  updatePreferences(value: ModelPreference) {
    this.setModel(value.model);
    this.setProvider(value.provider);
  }

  nextModel() {
    this.currentModelPreferenceIndex++;
    if (this.currentModelPreferenceIndex >= this.modelPreferences.length) {
      throw new Error("We have exhausted all model preferences.");
    }
    const nextModel = this.modelPreferences[this.currentModelPreferenceIndex];
    this.updatePreferences(nextModel);
  }

  getModel(): string {
    return this.modelName;
  }

  setModel(value: string) {
    this.modelName = value;
    this.client = null; // Reset client to force re-fetch
  }

  getProvider() {
    return this.provider;
  }

  setProvider(value: keyof typeof Clients.clients) {
    this.provider = value;
    this.client = null; // Reset client to force re-fetch
  }

  getClient() {
    if (!this.client) {
      if (this.provider) {
        console.log("Getting client for provider", this.provider);
        this.client = this.clientService.getClient(this.provider)?.client;
      }

      if (!this.client) {
        console.log("Getting client for model", this.modelName);
        this.client = this.clientService.getClient(
          undefined,
          this.modelName
        )?.client;
      }
    }
    return this.client;
  }

  setClient(client: GenericClient) {
    this.client = client;
  }

  setEasyFinalAnswer(value: boolean) {
    this.easyFinalAnswer = value;
  }

  getEnabledTools() {
    return this.tools
      .getTools()
      .filter((t) => !this.disabledTools.includes(t.function.name));
  }

  getEnabledToolNames() {
    return this.getEnabledTools().map((t) => t.function.name);
  }

  disableTool(toolName: string) {
    this.disabledTools.push(toolName);
  }

  isToolEnabled(toolName: string) {
    return !!this.getEnabledTools().find((t) => t.function.name === toolName);
  }

  enableTool(toolName: string) {
    if (!this.isToolEnabled(toolName)) {
      this.disabledTools = this.disabledTools.filter((t) => t !== toolName);
    }
  }

  private checkLimits(): boolean {
    // Check turn limit
    if (this.maxTurns !== null && this.turnCount >= this.maxTurns) {
      console.log(`Turn limit reached: ${this.turnCount}/${this.maxTurns}`);
      return true;
    }

    // Check spend limit
    if (this.maxSpend !== null && this.totalCostUsd >= this.maxSpend) {
      console.log(
        `Spend limit reached: $${this.totalCostUsd.toFixed(
          4
        )}/$${this.maxSpend.toFixed(4)}`
      );
      return true;
    }

    // Check runtime limit
    if (this.maxRunTimeMs !== null && this.startTimeMs !== null) {
      const currentRunTimeMs = Date.now() - this.startTimeMs;
      if (currentRunTimeMs >= this.maxRunTimeMs) {
        console.log(
          `Runtime limit reached: ${currentRunTimeMs}ms/${this.maxRunTimeMs}ms`
        );
        return true;
      }
    }

    return false;
  }

  private shouldTerminateFromLimits(): boolean {
    return this.checkLimits();
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  adjustTotalCostUsd(cost: number) {
    if (cost) {
      this.totalCostUsd += cost;
      this.agentEvents.emit(this.eventTypes.costUpdate, this.totalCostUsd);
    }
  }

  getTotalCostUsd() {
    return this.totalCostUsd;
  }

  startNewThread(messages: Message[]) {
    this.currentThread++;
    this.agentEvents.emit(this.eventTypes.newThread, messages);
    this.updateCurrentThread(messages);
  }

  updateCurrentThread(messages: Message[]) {
    this.threads[this.currentThread] = messages;
    this.agentEvents.emit(this.eventTypes.threadUpdate, messages);
  }

  getThreads() {
    return this.threads;
  }

  getSummaries() {
    return this.summaries;
  }

  abstract getInitialMessages(userInput: string): Promise<Message[]>;

  async processToolMessages(toolCall: ToolCall) {
    const { functionResp, toolMessages } = await this.tools.callTool(
      toolCall,
      this.getEnabledToolNames()
    );

    this.agentEvents.emit(this.eventTypes.toolUsed, {
      toolCall,
      functionResp,
    });

    return toolMessages;
  }

  logMessages(messages: Message[]) {
    for (const message of messages) {
      if (message.role === "assistant") {
        console.log(message.content);
      }
    }
  }

  formatInputContent(userInput: string) {
    return replaceEscapedNewLines(userInput);
  }

  formatAiResponse(response: string) {
    return restoreEscapedNewLines(response);
  }

  formatInputMessages(messages: Message[]) {
    return messages.map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? this.formatInputContent(m.content)
          : m.content,
    })) as Message[];
  }

  formatOutputMessages(messages: Message[]) {
    return messages.map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? this.formatAiResponse(m.content)
          : m.content,
    })) as Message[];
  }

  async healthCheck() {
    try {
      const canCallProvider = await this.getClient().createChatCompletion({
        messages: [{ role: "user", content: "Hello!" }],
        model: this.getModel(),
        max_tokens: 2,
      });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async selectHealthyModel() {
    const currentTime = Date.now();
    if (currentTime - this.lastHealthCheckTime < 60 * 1000) {
      return;
    }

    let healthy = await this.healthCheck();
    this.lastHealthCheckTime = Date.now();
    while (!healthy) {
      this.nextModel();
      healthy = await this.healthCheck();
    }
    await this.healthCheck();
  }

  isRequiredToolMissing() {
    const requiredToolAvailable = this.getEnabledToolNames().some(
      (t) =>
        this.requiredToolNames.includes(t) ||
        this.requiredToolNames.includes(mcpToolName(t))
    );

    if (requiredToolAvailable) {
      return false;
    }

    console.log(
      "Required tool not available, checking for finalAnswer",
      this.getEnabledToolNames(),
      this.requiredToolNames
    );

    // Otherwise we're missing the required tool, lets use finalAnswer if we have it
    const finalAnswer = "finalAnswer";
    const requiredFinalAnswer = this.requiredToolNames.includes(finalAnswer);
    const hasFinalAnswer = this.getEnabledToolNames().includes(finalAnswer);

    // We have the final answer tool, but it wasn't required
    if (hasFinalAnswer && !requiredFinalAnswer) {
      console.warn(
        "Required tool not available, setting finalAnswer as required tool"
      );
      this.requiredToolNames.push("finalAnswer");
      return false;
    }

    return true;
  }

  setNotHealthy() {
    this.lastHealthCheckTime = 0;
  }

  pause() {
    console.log("Pausing agent");
    this.agentEvents.emit(this.eventTypes.pause, this);
    this.status = this.eventTypes.pause;
  }

  unpause() {
    console.log("Unpausing agent");
    this.agentEvents.emit(this.eventTypes.unpause, this);
    this.status = "in_progress";
  }

  async unpaused() {
    return new Promise((resolve) => {
      console.log("Waiting for agent to unpause");
      this.agentEvents.once(this.eventTypes.unpause, () => {
        console.log("Agent resumed");
        resolve(true);
      });
      this.agentEvents.once(this.eventTypes.done, () => {
        resolve(true);
      });
    });
  }

  async kill() {
    console.log("Killing agent");
    this.agentEvents.emit(this.eventTypes.kill, this);
    this.status = this.eventTypes.kill;

    this.addPendingUserMessage({
      role: "user",
      content: `<Workflow>The user has requested the task to end, please call ${this.requiredToolNames} with a report of your ending state</Workflow>`,
    } as Message);
  }

  async call(userInput: string, _messages?: Message[]) {
    if (this.status === this.eventTypes.pause) {
      await this.unpaused();
    }

    await this.selectHealthyModel();

    // Increment turn count and check limits (only for new calls, not recursive ones)
    this.turnCount++;
    if (this.shouldTerminateFromLimits()) {
      const currentRunTimeMs = this.startTimeMs
        ? Date.now() - this.startTimeMs
        : 0;
      const limitMsg = `Task terminated due to limits reached. Turn: ${
        this.turnCount
      }/${this.maxTurns || "unlimited"}, Cost: $${this.totalCostUsd.toFixed(
        4
      )}/${
        this.maxSpend ? "$" + this.maxSpend.toFixed(4) : "unlimited"
      }, Runtime: ${currentRunTimeMs}ms/${
        this.maxRunTimeMs ? this.maxRunTimeMs + "ms" : "unlimited"
      }`;
      this.status = this.eventTypes.done;
      this.agentEvents.emit(this.eventTypes.done, limitMsg);
      return limitMsg;
    }

    try {
      const model = this.getModel();
      let messages = _messages || (await this.getInitialMessages(userInput));

      // Process initial messages if this is the first call
      if (!_messages) {
        messages = await this.messageProcessor.processMessages(
          messages,
          "initial_call"
        );
      }

      if (this.pendingUserMessages.length) {
        messages.push(...this.pendingUserMessages);
        this.pendingUserMessages = [];
      }

      messages = this.formatInputMessages(messages);
      this.updateCurrentThread(messages);
      const isMissingTool = this.isRequiredToolMissing();

      const startIndex = 0;
      const endIndex = messages.length;

      // Process messages before each AI call
      messages = await this.messageProcessor.processMessages(
        messages,
        "pre_call"
      );
      const compressThreshold = 10000;

      const response = await this.getClient().createChatCompletion({
        model,
        messages,
        tools: this.getEnabledTools(),
        tool_choice: "auto",
      });

      if (response?.usd_cost === undefined) {
        console.warn(
          "Response cost is undefined",
          JSON.stringify(response, null, 2)
        );
        const error = response as any;
        if ("response" in error && "data" in error.response) {
          console.warn(
            "Response data",
            JSON.stringify(error.response.data, null, 2)
          );
        }
      }

      this.adjustTotalCostUsd(response?.usd_cost);

      // Typically, there's only one choice in the array, but you could have many
      // If you set `n` to more than 1, you will get multiple choices
      for (const choice of response.choices) {
        messages.push(choice.message);

        messages = await this.messageProcessor.processMessages(
          messages,
          "post_call"
        );

        const lastMessage = messages[messages.length - 1];

        this.logMessages([lastMessage]);

        const toolCalls = lastMessage.tool_calls;
        if (lastMessage.tool_calls) {
          // About to call a tool, process the messages
          // We could add all the tool calls, and do this once
          messages = await this.messageProcessor.processMessages(
            messages,
            "pre_tools"
          );

          for (const toolCall of toolCalls) {
            const toolMessages = await this.processToolMessages(toolCall);
            // Add the tool responses to the thread
            messages.push(...(toolMessages as Message[]));

            const finalMessage = toolMessages.find(
              (m) =>
                this.requiredToolNames.includes(m.name) ||
                this.requiredToolNames.includes(mcpToolName(m.name))
            );

            if (finalMessage) {
              // Emit task completion event for plugins (like GitPlugin)
              this.events.emit("agent:taskComplete", {
                taskId:
                  this.currentTaskId ||
                  this.startTimeMs?.toString() ||
                  Date.now().toString(),
                result: finalMessage.content || "Done",
              });
              const doneMsg = finalMessage.content || "Done";
              this.agentEvents.emit(this.eventTypes.done, doneMsg);
              this.status = this.eventTypes.done;
              return doneMsg;
            }
          }
        }
      }

      const newToolCalls = response.choices.flatMap(
        (c) => c.message.tool_calls
      );
      // Process messages after tool execution
      if (newToolCalls && newToolCalls.length > 0) {
        messages = await this.messageProcessor.processMessages(
          messages,
          "post_tools"
        );
      }

      // Early exit: not required to call tool
      const firstMessage = response.choices[0].message;
      if (
        response.choices.length === 1 &&
        firstMessage.content &&
        this.easyFinalAnswer
      ) {
        this.status = this.eventTypes.done;
        this.agentEvents.emit(this.eventTypes.done, firstMessage.content);
        return firstMessage.content;
      }

      // infinite loop if we cannot exit
      if (isMissingTool) {
        const error = `Required tool: ${JSON.stringify(
          this.requiredToolNames
        )} not available, options are ${this.getEnabledToolNames().join(", ")}`;
        console.error(error);
        this.status = this.eventTypes.done;
        this.agentEvents.emit(this.eventTypes.done, error);
        return error;
      }

      // Early exit: killed, agent was requested to wrap up
      if (
        this.pendingUserMessages.length === 0 &&
        this.status === this.eventTypes.kill
      ) {
        console.log("Agent killed, stopping execution");
        this.status = this.eventTypes.done;
        this.agentEvents.emit(this.eventTypes.done, firstMessage.content);
        return firstMessage.content;
      }

      if (
        this.getMessagesLength(messages) > compressThreshold &&
        messages.length > 20
      ) {
        const taskBreakdown = await this.getTaskBreakdown(messages);
        console.log(
          "Compressing messages",
          this.getMessagesLength(messages),
          "exceeds",
          compressThreshold
        );
        messages = await this.compressMessages(messages, startIndex, endIndex);
        this.startNewThread(messages);
      }

      if (["assistant", "tool"].includes(messages[messages.length - 1].role)) {
        // sometimes the agent just says a message and doesn't call a tool, or compression ends on a tool message
        console.log(
          "Agent continuing to the next iteration, reminding agent how to terminate"
        );

        const remainingTime =
          this.maxRunTimeMs && this.startTimeMs
            ? this.maxRunTimeMs - (Date.now() - this.startTimeMs)
            : null;

        const remainingTurns = this.maxTurns
          ? this.maxTurns - this.turnCount
          : null;

        const timeRemainsingMsg = remainingTime
          ? `You have approximately ${Math.floor(
              remainingTime / 1000
            )} seconds remaining for this task. `
          : "";

        const turnsRemainingMsg = remainingTurns
          ? `You have ${remainingTurns} turns remaining. `
          : "";

        const remainingBudget = this.maxSpend
          ? this.maxSpend - this.totalCostUsd
          : null;
        const budgetRemainingMsg = remainingBudget
          ? `You have $${remainingBudget.toFixed(4)} remaining in your budget.`
          : "";

        const continuation = `<Workflow>
        workflow continues until you call one of ${this.requiredToolNames}.\n
        ${timeRemainsingMsg}
        ${turnsRemainingMsg}
        ${budgetRemainingMsg}
        </Workflow>`;

        messages.push({
          role: "user",
          content: continuation,
        });
      }

      this.updateCurrentThread(messages);
      return this.call(userInput, messages);
    } catch (e) {
      if (e.toString().includes("429")) {
        this.setNotHealthy();
        return this.call(userInput, _messages);
      }

      console.error("Agent failed", e);

      if ("response" in e && "data" in e.response) {
        console.error(
          "Error response data:",
          JSON.stringify(e.response.data, null, 2)
        );
      }

      this.agentEvents.emit(this.eventTypes.done, e.message);
      return e.message;
    }
  }

  addPendingUserMessage(message: Message) {
    if (this.status === this.eventTypes.done) {
      console.warn("Agent is done, cannot take more messages");
    } else {
      this.pendingUserMessages.push(message);
    }
  }

  getMessagesLength(messages: Message[]) {
    return JSON.stringify(messages).split(" ").length;
  }

  async getTaskBreakdown(messages: Message[]) {
    if (this.taskBreakdown) {
      return this.taskBreakdown;
    }

    const taskPrompt = `
    Generate a detailed task breakdown for this conversation, include a section for the following:
    1. Task List
    2. Completion Criteria - when the agent should stop

    This output will be used to guide the work of the agent, and determine when we've accomplished the goal

    \n\n<ToAnalyze>${JSON.stringify(messages)}</ToAnalyze>`;

    const model = this.getModel();

    const response = await this.getClient().createChatCompletion({
      model,
      messages: [
        {
          role: "user",
          content: taskPrompt,
        },
      ],
      max_tokens: 2000,
    });

    this.adjustTotalCostUsd(response.usd_cost);

    console.log(response);

    this.taskBreakdown = response.choices[0].message.content;
    return this.taskBreakdown;
  }

  async compressMessages(
    messages: Message[],
    startIndex: number,
    endIndex: number
  ) {
    console.log(
      "Compressing messages from",
      startIndex,
      "to",
      endIndex,
      "total messages:",
      messages.length
    );
    const toCompress = messages.slice(startIndex, endIndex);
    const toCompressPrompt = `We are compressing our conversation to save memory.
    Please summarize the conversation so far, so that we may continue the original task with a smaller context

    Include the following sections:
    1. Initial Request - what this agent was originally tasked with.
    2. Progress - what has been tried so far,
    3. Next Steps - what we're about to do next to continue the user's original request.
    4. Tasks remaining - what tasks are left from the initial task breakdown.

    Our initial task breakdown: ${this.taskBreakdown}

    This summary will become the agent's only memory of the past, all other messages will be dropped:

      `;

    const model = this.getModel();

    const response = await this.getClient().createChatCompletion({
      model,
      messages: [
        ...messages,
        {
          role: "user",
          content: toCompressPrompt,
        },
      ],
    });

    this.adjustTotalCostUsd(response.usd_cost);

    const summaries = response.choices.map((c) => c.message.content);
    this.summaries.push(...summaries);

    const startMessages = [
      {
        role: "user",
        content: `
        Initial task breakdown:
        ${this.taskBreakdown}

        We have just compressed the conversation to save memory:
        ${JSON.stringify(summaries)}

        Please continue the task from where we left off
        `,
      },
    ] as Message[];
    const systemMesasges = toCompress.filter((m) => m.role === "system");

    const newMessages = [
      ...systemMesasges,
      ...startMessages,
      ...messages.slice(endIndex),
    ];

    const oldLength = this.getMessagesLength(messages);
    const newLength = this.getMessagesLength(newMessages);
    const compressionRatio = (
      ((oldLength - newLength) / oldLength) *
      100
    ).toFixed(2);

    console.log(
      "Compressed messages from",
      oldLength,
      "to",
      newLength,
      compressionRatio + "%",
      "reduction in size"
    );

    return newMessages;
  }
}
