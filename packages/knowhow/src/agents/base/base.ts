import { EventEmitter } from "events"; // kept for reference; agentEvents now uses EventService
import {
  CompletionResponse,
  CompletionOptions,
  GenericClient,
  Message,
  MessageContent,
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
import { DEFAULT_CONTEXT_LIMIT } from "../../clients/contextLimits";
import { Marked } from "../../utils";
import { TraceAll } from "../../util/Trace";

export { Message, Tool, ToolCall };
export interface ModelPreference {
  model: string;
  provider: keyof typeof Clients.clients;
  reasoning_effort?: CompletionOptions["reasoning_effort"];
  reasoning_summary?: boolean;
}

export interface AgentContext {
  Tools?: ToolsService;
  Events?: EventService;
  messageProcessor?: MessageProcessor;
  Clients?: AIClient;
}

export interface ToolCallEvent {
  toolCall: ToolCall;
  functionResp: any;
}

type ChatCompletion = Parameters<GenericClient["createChatCompletion"]>[0];
type CachedChatCompletion = { messages: ChatCompletion["messages"] } & Partial<
  Omit<ChatCompletion, "messages">
>;

interface CompletedCompaction {
  compressionEnd: number;
  originalPrefix: Message[];
  replacementPrefix: Message[];
  summary: string;
}

/**
 * A source is anything that can (a) start producing data, (b) hand each datum to
 * a callback, and (c) be torn down. This is the unified contract behind
 * `agent.observe()` — tool polls, events, streams, promises, peer agent threads,
 * file tails, etc. all become adapters that satisfy this shape.
 */
export interface ObservationSource {
  /** Human-friendly label for logs / delivered messages. */
  label: string;
  /**
   * Begin producing. Call `emit(datum)` for each piece of data. Return a
   * teardown function (or void). May be sync or async.
   */
  start(
    emit: (datum: unknown) => void
  ): void | (() => void) | Promise<void | (() => void)>;
}

export interface ObserveOpts {
  /** Only deliver when the datum changed since the last emit. Default true. */
  onlyOnChange?: boolean;
  /** Max number of updates before auto-stopping. Default 20. */
  maxUpdates?: number;
  /** Max total duration in ms before auto-stopping. Default 10 min. */
  maxDurationMs?: number;
}

interface ActiveObservation {
  id: string;
  label: string;
  updates: number;
  teardownPromise: Promise<void | (() => void)>;
  expiry?: NodeJS.Timeout;
}

@TraceAll()
export abstract class BaseAgent implements IAgent {
  abstract name: string;
  abstract description: string;

  private status = "not_started";
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
  protected reasoningEffort: CompletionOptions["reasoning_effort"] | undefined =
    undefined;
  protected summarizeReasoning: boolean | undefined = undefined;
  protected totalInputTokens = 0;
  protected totalOutputTokens = 0;
  protected totalCacheReadTokens = 0;
  protected totalCacheWriteTokens = 0;

  // The real prompt/input token count reported by the most recent completion
  // response (input + cache read + cache write). This reflects exactly how many
  // tokens the model consumed for the last request and is far more accurate than
  // the whitespace-based estimate in getMessagesLength(). Used to decide when to
  // compact. 0 means "no real usage seen yet" (fall back to the estimate).
  protected lastPromptTokens = 0;

  protected compressThreshold = 30000;
  protected compressMinMessages = 30;

  // Set when the user manually requests compaction (e.g. via /compact while
  // attached). Forces the next loop iteration to compress the conversation
  // regardless of whether the token threshold has been reached.
  protected _forceCompact = false;

  // Compaction is intentionally detached from the main agent loop. A failed
  // attempt is cleared so a later turn can retry without ending the task.
  private _compactionPromise: Promise<void> | null = null;
  private _completedCompaction: CompletedCompaction | null = null;
  private _compactionGeneration = 0;

  // Interrupt support: resolves the currently awaited tool call or completion
  private _interruptResolve: (() => void) | null = null;
  // A monotonically-increasing token identifying the active interruptible window.
  // Used to ensure a stale (slow) operation completing in the background cannot
  // clobber a newer interruptible window's resolver.
  private _interruptToken = 0;

  protected threads = [] as Message[][];

  // Message from users
  protected pendingUserMessages = [] as Message[];

  // Internal messages
  protected pendingMessages = [] as Message[];

  // Active observations (subscriptions) owned by this agent instance. Kept
  // per-agent (not module scope) so stopObserving() on one agent can't clobber
  // another agent's observers, and so newTask() can tear them all down.
  protected _observations = new Map<string, ActiveObservation>();
  private _observationSeq = 0;

  protected taskBreakdown = "";
  protected summaries = [] as string[];
  protected currentTaskId: string | null = null;
  /**
   * The taskId of the parent agent that spawned this task, if any.
   * Used by self-referential tools (e.g. replyToParent) to know who to
   * report back to without relying solely on reading metadata.json off disk.
   */
  public parentTaskId: string | null = null;

  public agentEvents = new EventService();
  public eventTypes = {
    newThread: "new_thread",
    threadUpdate: "thread_update",
    costUpdate: "cost_update",
    agentLog: "agent:log",
    toolCall: "tool:pre_call",
    toolUsed: "tool:post_call",
    agentStatus: "agent:status",
    notStarted: "not_started",
    inProgress: "in_progress",
    done: "done",
    pause: "pause",
    kill: "kill",
    unpause: "unpause",
    agentMsg: "agent:msg",
    userSay: "user:say",
    agentSay: "agent:say",
    agentNewTask: "agent:newTask",
    agentTaskComplete: "agent:taskComplete",
    tokenUsage: "agent:tokenUsage",
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
    // Use setListener with a key so re-creating the agent doesn't double-subscribe
    this.events.setListener(
      {
        key: `agent:msg:${this.constructor.name}`,
        event: this.eventTypes.agentMsg,
      },
      (eventData: any) => {
        if (
          this.status === this.eventTypes.inProgress ||
          this.status === this.eventTypes.pause
        ) {
          const message = {
            role: "user",
            content: JSON.stringify(eventData),
          } as Message;
          this.addPendingMessage(message);
        }
      }
    );
  }

  protected log(
    message: string,
    level: "info" | "warn" | "error" = "info"
  ): void {
    this.agentEvents.emit(this.eventTypes.agentLog, {
      agentName: this.name,
      message,
      level,
      timestamp: Date.now(),
      taskId: this.currentTaskId,
    });
  }

  setCompressThreshold(threshold: number) {
    this.compressThreshold = threshold;
  }

  /**
   * Request that the conversation be compacted at the next loop iteration,
   * regardless of whether the token threshold has been reached. Combined with
   * an interrupt(), this lets a user force compaction on an attached agent
   * mid-task (e.g. via the `/compact` chat command) to drop back to a much
   * cheaper per-interaction context size.
   */
  requestCompact() {
    this._forceCompact = true;
  }

  /**
   * Returns the effective compress threshold for the current model.
   * If the user has manually set a custom threshold (different from the default 30k),
   * that value is used as-is. Otherwise, the threshold is dynamically computed as
   * 70% of the model's context window limit (or tiered-pricing threshold), falling
   * back to DEFAULT_CONTEXT_LIMIT. The 70% factor leaves headroom so token-count
   * lag doesn't push a request past the model/tier limit before compression fires.
   */
  getCompressThreshold(): number {
    if (this.compressThreshold !== DEFAULT_CONTEXT_LIMIT) {
      return this.compressThreshold;
    }
    const result = this.clientService.getContextLimit(
      this.getProvider() as string,
      this.getModel()
    );
    const contextLimit = result?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    const threshold = result?.threshold ?? contextLimit;
    return Math.floor(threshold * 0.7);
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
    // Invalidate any detached compaction still finishing for the previous task.
    this._compactionGeneration++;
    this._compactionPromise = null;
    this._completedCompaction = null;
    this.currentThread = 0;
    this.threads = [];
    this.taskBreakdown = "";
    this.summaries = [];
    this.totalCostUsd = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheWriteTokens = 0;
    this.lastPromptTokens = 0;
    this.status = this.eventTypes.inProgress;
    this.turnCount = 0;
    this.startTimeMs = Date.now();
    this.currentTaskId = taskId || this.startTimeMs.toString();

    // Reset interrupt state so a queued/stale interrupt from a prior task
    // can't fire against the new task.
    this._interruptResolve = null;
    this._forceCompact = false;

    // Tear down any observers from a prior task so they can't leak or inject
    // into the new task.
    this.stopObserving(undefined, "new task started");

    // Emit event for plugin integration
    const id = taskId || this.startTimeMs.toString();
    this.events.emit(this.eventTypes.agentNewTask, {
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
    if (value.reasoning_effort !== undefined) {
      this.reasoningEffort = value.reasoning_effort;
    }
    if (value.reasoning_summary !== undefined) {
      this.summarizeReasoning = value.reasoning_summary;
    }
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

  getParentTaskId(): string | null {
    return this.parentTaskId;
  }

  setParentTaskId(value: string | null) {
    this.parentTaskId = value ?? null;
  }

  setProvider(value: keyof typeof Clients.clients) {
    this.provider = value;
    this.client = null; // Reset client to force re-fetch
  }

  setReasoningEffort(effort: CompletionOptions["reasoning_effort"]) {
    this.reasoningEffort = effort;
  }

  getReasoningEffort(): CompletionOptions["reasoning_effort"] {
    return this.reasoningEffort;
  }

  setSummarizeReasoning(value: boolean) {
    this.summarizeReasoning = value;
  }

  getSummarizeReasoning(): boolean | undefined {
    return this.summarizeReasoning;
  }

  getClient() {
    if (!this.client) {
      if (this.provider) {
        this.log(`Getting client for provider ${this.provider}`);
        const clientInfo = this.clientService.getClient(this.getProvider());
        if (clientInfo) {
          this.client = clientInfo.client;
          // don't set provider or model yet
        }
      }

      if (!this.client) {
        this.log(`Getting client for model ${this.modelName}`);
        const clientInfo = this.clientService.getClient(
          undefined,
          this.getModel()
        );

        if (clientInfo) {
          this.client = clientInfo.client;
        }
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

  /**
   * Detect if the model's response is a termination signal (e.g. "Done", "Complete", "Finished", "finalAnswer")
   * This handles the case where an agent refuses to call finalAnswer and just says a short termination word.
   */
  protected isTerminationResponse(content: string): boolean {
    const trimmed = content.trim();
    // Short response (≤ 3 words) that matches a termination word/phrase exactly
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 3) {
      const terminationPattern =
        /^(done|complete|completed|finished|final\s*answer|task\s*complete|all\s*done|that'?s\s*(all|it)|ok(ay)?|yes)[.!]*$/i;
      if (terminationPattern.test(trimmed)) return true;
    }

    // Check if the first 1-3 words indicate task completion (for longer responses)
    // e.g. "Task complete: ...", "All done.", "No further changes needed.", "Confirmed complete."
    const firstWords = trimmed.split(/\s+/).slice(0, 3).join(" ");
    const firstWordPattern =
      /^(task\s*(complete|completed|done|finished)|all\s*done|no\s*(further|more|additional|changes|action)|confirmed?\s*(complete|done|finished|one\s*last)|nothing\s*(more|further|else)|standing\s*by|everything\s*is|still\s*confirmed|acknowledged|done\s*and|complete\s*(and|\.)|completed\s*successfully|no\s*additional|verified\s*and)/i;
    if (firstWordPattern.test(firstWords)) return true;

    // If easyFinalAnswer mode is on, also match response starting with "✅" or numbered confirmation lists
    if (this.easyFinalAnswer) {
      if (trimmed.startsWith("✅") || /^[\d\.\-\*]/.test(trimmed)) return true;
    }

    // Detect JSON-wrapped finalAnswer output, e.g. {"answer":"..."} or {"finalAnswer":"..."}
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.answer === "string") return true;
        if (typeof parsed.finalAnswer === "string") return true;
      }
    } catch (_) {}

    return false;
  }

  getEnabledTools() {
    return this.tools
      .getTools()
      .filter((t) => !this.disabledTools.includes(t.function.name));
  }

  getEnabledToolNames() {
    return this.getEnabledTools().map((t) => t.function.name);
  }

  /** Restore the exact request-visible tool list persisted for a prior run. */
  restoreEnabledTools(names: string[]) {
    const uniqueNames = [...new Set(names)];
    const lazyTools = this.tools as ToolsService & {
      enableTools?: (patterns: string[]) => unknown;
      restoreEnabledTools?: (names: string[]) => void;
    };

    // LazyToolsService only exposes explicitly enabled tools. Materialize the
    // saved concrete names before applying the agent-level exact-set filter.
    if (lazyTools.restoreEnabledTools) {
      lazyTools.restoreEnabledTools(uniqueNames);
    } else {
      lazyTools.enableTools?.(uniqueNames);
    }
    const savedNames = new Set(uniqueNames);
    this.disabledTools = this.tools
      .getTools()
      .map((tool) => tool.function.name)
      .filter((name) => !savedNames.has(name));
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
      this.log(
        `Turn limit reached: ${this.turnCount}/${this.maxTurns}`,
        "warn"
      );
      return true;
    }

    // Check spend limit
    if (this.maxSpend !== null && this.totalCostUsd >= this.maxSpend) {
      this.log(
        `Spend limit reached: $${this.totalCostUsd.toFixed(
          4
        )}/$${this.maxSpend.toFixed(4)}`,
        "warn"
      );
      return true;
    }

    // Check runtime limit
    if (this.maxRunTimeMs !== null && this.startTimeMs !== null) {
      const currentRunTimeMs = this.runTime();
      if (currentRunTimeMs >= this.maxRunTimeMs) {
        this.log(
          `Runtime limit reached: ${currentRunTimeMs}ms/${this.maxRunTimeMs}ms`,
          "warn"
        );
        return true;
      }
    }

    return false;
  }

  public runTime() {
    if (this.startTimeMs) {
      return Date.now() - this.startTimeMs;
    }
    return 0;
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

  adjustTokenUsage(
    usage: any,
    messages?: Message[],
    updateLastPromptTokens = true
  ) {
    if (!usage) return;
    // Support both OpenAI-style (prompt_tokens/completion_tokens) and Anthropic-style (input_tokens/output_tokens)
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;

    const cacheReadTokens =
      usage.cache_read_input_tokens ??
      usage.cache_read_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0;
    const cacheWriteTokens =
      usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0;

    // Record the real prompt token count for this single completion (not the
    // running total). This represents the full context the model processed for
    // the request: fresh input + cache-read + cache-write tokens. It is used by
    // the compaction check as an accurate replacement for the whitespace-based
    // getMessagesLength() estimate. Only track it for "prompt-shaped" usage
    // (i.e. when there are input tokens) so a usage-less interrupt stub doesn't
    // reset it to 0.
    const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
    if (updateLastPromptTokens && promptTokens > 0) {
      this.lastPromptTokens = promptTokens;
    }

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheReadTokens += cacheReadTokens;
    this.totalCacheWriteTokens += cacheWriteTokens;

    this.agentEvents.emit(this.eventTypes.tokenUsage, {
      timestamp: new Date().toISOString(),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      messages,
    });
  }

  getTokenUsage() {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
    };
  }

  /**
   * Centralized helper for making an AI completion call while ensuring
   * cost (totalCostUsd) and token usage (input/output/cache) are always
   * updated consistently, regardless of which part of the agent triggers
   * the completion (main call loop, task breakdown, compression, etc).
   *
   * Optionally supports being interrupted via makeInterruptible by passing
   * an `interruptValue` in options - if the operation is interrupted, the
   * interrupt value is returned and used for cost/usage tracking (which,
   * for a typical interrupt stub with no usage/cost, is effectively a
   * no-op).
   */
  protected async createAgentCompletion(
    params: CachedChatCompletion,
    options: {
      interruptValue?: CompletionResponse;
      updateLastPromptTokens?: boolean;
    } = {}
  ): Promise<CompletionResponse> {
    const { interruptValue, updateLastPromptTokens = true } = options;

    // If you change the tools, or any of this, you bust cache
    // only safe to change messages
    const defaultedParams: ChatCompletion = {
      model: this.getModel(),
      tools: this.getEnabledTools(),
      tool_choice: "auto",
      long_ttl_cache: this.runTime() > 300_000,
      ...(this.reasoningEffort !== undefined && {
        reasoning_effort: this.reasoningEffort,
      }),
      ...(this.summarizeReasoning !== undefined && {
        reasoning_summary: this.summarizeReasoning,
      }),

      ...params,
    };

    const callPromise = this.getClient().createChatCompletion(defaultedParams);
    const response = interruptValue
      ? await this.makeInterruptible(callPromise, interruptValue)
      : await callPromise;

    this.adjustTotalCostUsd(response?.usd_cost);
    this.adjustTokenUsage(
      response?.usage,
      params.messages,
      updateLastPromptTokens
    );

    return response;
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

  abstract getInitialMessages(
    userInput: string | MessageContent[]
  ): Promise<Message[]>;

  async processToolMessages(toolCall: ToolCall) {
    this.agentEvents.emit(this.eventTypes.toolCall, { toolCall });

    const interruptMsg = `User interrupted this tool call (${toolCall.function?.name})`;
    const interruptResult: Awaited<ReturnType<typeof this.tools.callTool>> = {
      functionResp: interruptMsg,
      toolCallId: toolCall.id,
      functionName: toolCall.function?.name,
      functionArgs: {},
      toolMessages: [
        {
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function?.name,
          content: interruptMsg,
        },
      ],
    };

    const { functionResp, toolMessages } = await this.makeInterruptible(
      // Pass this agent in as the per-call context (`_ctx`) so tools can be
      // self-referential: they can read `_ctx.caller` (this agent) and
      // `_ctx.taskId` to, e.g., look up the current task, send pending
      // messages, or subscribe to the caller's events.
      this.tools.callTool(toolCall, this.getEnabledToolNames(), {
        caller: this,
        taskId: this.currentTaskId,
        parentTaskId: this.parentTaskId ?? undefined,
      }),
      interruptResult
    );

    this.agentEvents.emit(this.eventTypes.toolUsed, {
      toolCall,
      functionResp,
    });

    return toolMessages;
  }

  logMessages(messages: Message[]) {
    for (const message of messages) {
      // Surface the model's reasoning summary (what it's "thinking") when the
      // provider exposes one, so it appears alongside the assistant's output.
      const reasoningSummary = (message as any).reasoning_summary;
      if (message.role === "assistant" && reasoningSummary) {
        this.agentEvents.emit(this.eventTypes.agentSay, {
          message: `💭 ${reasoningSummary}`,
        });
      }
      if (message.role === "assistant" && message.content) {
        this.agentEvents.emit(this.eventTypes.agentSay, {
          message: message.content,
        });
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
      this.log(String(e), "error");
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
      (enabled) =>
        this.requiredToolNames.includes(enabled) ||
        this.requiredToolNames.includes(mcpToolName(enabled)) ||
        this.requiredToolNames.some((required) => enabled.endsWith(required))
    );

    if (requiredToolAvailable) {
      return false;
    }

    this.log(
      `Required tool: [${
        this.requiredToolNames
      }] not available, checking for finalAnswer. Enabled: ${this.getEnabledToolNames().join(
        ", "
      )}`
    );

    // Otherwise we're missing the required tool, lets use finalAnswer if we have it
    const finalAnswer = "finalAnswer";
    const requiredFinalAnswer = this.requiredToolNames.includes(finalAnswer);
    const hasFinalAnswer = this.getEnabledToolNames().includes(finalAnswer);

    // We have the final answer tool, but it wasn't required
    if (hasFinalAnswer && !requiredFinalAnswer) {
      this.log(
        "Required tool not available, setting finalAnswer as required tool",
        "warn"
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
    this.log("Pausing agent");
    this.agentEvents.emit(this.eventTypes.pause, this);
    this.status = this.eventTypes.pause;
  }

  unpause() {
    this.log("Unpausing agent");
    this.agentEvents.emit(this.eventTypes.unpause, this);
    this.status = this.eventTypes.inProgress;
  }

  async unpaused() {
    return new Promise((resolve) => {
      this.log("Waiting for agent to unpause");
      this.agentEvents.once(this.eventTypes.unpause, () => {
        this.log("Agent resumed");
        resolve(true);
      });
      this.agentEvents.once(this.eventTypes.done, () => {
        resolve(true);
      });
    });
  }

  async kill() {
    this.log("Killing agent");
    if (
      this.status === this.eventTypes.kill ||
      this.status === this.eventTypes.done
    ) {
      this.log(
        "Agent is already being killed or done, ignoring duplicate kill()",
        "warn"
      );
      return;
    }
    this.agentEvents.emit(this.eventTypes.kill, this);
    this.status = this.eventTypes.kill;

    this.addPendingMessage({
      role: "user",
      content: `<Workflow>The user has requested the task to end, please call ${this.requiredToolNames} with a report of your ending state</Workflow>`,
    } as Message);
  }

  /**
   * Wrap a promise so it can be interrupted via interrupt().
   * If interrupt() is called while waiting, the promise resolves with the
   * interrupt message instead of waiting for the original operation to complete.
   */
  protected makeInterruptible<T>(
    promise: Promise<T>,
    interruptValue: T
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Each interruptible window gets a unique token. `settled` guards this
      // specific window so it can only ever resolve/reject once, and the token
      // ensures a stale (slow) background operation that finishes AFTER this
      // window was interrupted cannot clobber a NEWER window's resolver.
      const myToken = ++this._interruptToken;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        // Only clear the shared resolver if it still belongs to this window.
        if (this._interruptToken === myToken) {
          this._interruptResolve = null;
        }
        fn();
      };

      this._interruptResolve = () => finish(() => resolve(interruptValue));

      promise
        .then((result) => {
          // If this window was already interrupted/settled, drop the stale
          // result — do NOT touch _interruptResolve (it may belong to a newer
          // window now).
          finish(() => resolve(result));
        })
        .catch((err) => {
          // If the window was already interrupted, swallow the late error.
          if (settled) return;
          finish(() => reject(err));
        });
    });
  }

  /**
   * Interrupt the currently awaited tool call or AI completion.
   * The waiting promise will resolve immediately with an interrupt message,
   * allowing the agent to continue its loop with the interruption as context.
   */
  interrupt(message = "User interrupted this action you were waiting on") {
    this.log(`Interrupting current operation: ${message}`);

    // If the user supplied a real message with the poke (not the default
    // interrupt reason), queue it as a pending user message so the agent
    // actually sees what they said on its next step.
    if (
      message &&
      message !== "User interrupted this action you were waiting on"
    ) {
      this.addPendingUserMessage({ role: "user", content: message });
    }

    if (this._interruptResolve) {
      this._interruptResolve();
    } else {
      // No active interruptible window right now (we're between the AI
      // completion and the tool call, or in message processing). There is
      // nothing to interrupt, so we do NOT queue it — a queued interrupt
      // would pre-empt the next tool call and drop its result. Any message
      // supplied with the poke was already added as a pending user message
      // above, so the agent will still see it on its next step.
      this.log("No active interruptible operation to interrupt", "warn");
    }
  }

  async call(
    userInput: string | MessageContent[],
    _messages?: Message[],
    retryCount = 0
  ) {
    if (this.status === this.eventTypes.notStarted) {
      this.status = this.eventTypes.inProgress;
    }

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

      if (this.pendingMessages.length) {
        messages.push(...this.pendingMessages);
        this.pendingMessages = [];
      }

      messages = this.formatInputMessages(messages);
      this.updateCurrentThread(messages);
      const isMissingTool = this.isRequiredToolMissing();

      // Process messages before each AI call
      messages = await this.messageProcessor.processMessages(
        messages,
        "pre_call"
      );

      const interruptResponse: CompletionResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "User interrupted this AI completion. Please continue.",
            },
          },
        ],
        model,
        usage: undefined,
        usd_cost: 0,
      };

      const response = await this.createAgentCompletion(
        {
          model,
          messages,
          tools: this.getEnabledTools(),
          tool_choice: "auto",
          long_ttl_cache: this.runTime() > 300_000,
          ...(this.reasoningEffort !== undefined && {
            reasoning_effort: this.reasoningEffort,
          }),
          ...(this.summarizeReasoning !== undefined && {
            reasoning_summary: this.summarizeReasoning,
          }),
        },
        { interruptValue: interruptResponse }
      );

      // If the agent was paused while the completion was in-flight, wait here
      // before processing tool calls. This allows the user to send messages
      // (via addPendingUserMessage) and prevents the agent from proceeding to
      // tool calls (e.g. finalAnswer) without seeing those interactions.
      if (this.status === this.eventTypes.pause) {
        this.log(
          "Agent was paused after completion, waiting before processing tool calls"
        );
        await this.unpaused();
      }

      if (response?.usd_cost === undefined) {
        this.log(
          `Response cost is undefined: ${JSON.stringify(response, null, 2)}`,
          "warn"
        );
        const error = response as any;
        if (error != null && "response" in error && "data" in error.response) {
          this.log(
            `Response data: ${JSON.stringify(error.response.data, null, 2)}`,
            "warn"
          );
        }
        if (!response?.choices) {
          const errMsg =
            (error?.error?.message ?? error?.message) ||
            JSON.stringify(response);
          throw new Error(`AI response error: ${errMsg}`);
        }
      }

      this.log("agent response cost: " + response?.usd_cost);

      // Typically, there's only one choice in the array, but you could have many
      // If you set `n` to more than 1, you will get multiple choices
      // Collect all tool calls across all choices up front.
      // This is used by detectTruncatedToolCalls so that the size heuristic
      // compares the full completion_tokens against ALL argument content,
      // rather than just the current choice's single tool call (Anthropic maps
      // each parallel tool_use block to a separate choice).
      const allResponseToolCalls = response.choices.flatMap(
        (c) => c.message.tool_calls ?? []
      );
      for (const choice of response.choices) {
        messages.push(choice.message);

        messages = await this.messageProcessor.processMessages(
          messages,
          "post_call"
        );

        const lastMessage = messages[messages.length - 1];

        this.logMessages([lastMessage]);

        if (lastMessage.tool_calls) {
          // About to call a tool, process the messages
          // We could add all the tool calls, and do this once
          messages = await this.messageProcessor.processMessages(
            messages,
            "pre_tools"
          );

          // Re-derive toolCalls from the freshly processed messages, since
          // pre_tools processors (e.g. MinimalToolsMessageProcessor) may have
          // rewritten the tool_calls on a deep-copied message array.
          const toolCalls = messages[messages.length - 1].tool_calls;

          this.updateCurrentThread(messages);

          const truncationWarning = this.detectTruncatedToolCalls(
            toolCalls,
            response,
            allResponseToolCalls
          );
          if (truncationWarning) {
            messages.push(truncationWarning as Message);
            this.updateCurrentThread(messages);
            return this.call(userInput, messages);
          }

          for (const toolCall of toolCalls) {
            if (this.status === this.eventTypes.pause) {
              this.log(
                "Agent was paused before tool call, waiting before processing tool calls"
              );
              await this.unpaused();
            }

            const toolMessages = await this.processToolMessages(toolCall);
            // Add the tool responses to the thread
            messages.push(...(toolMessages as Message[]));

            const finalMessage = toolMessages.find(
              (called) =>
                this.requiredToolNames.includes(called.name) ||
                this.requiredToolNames.includes(mcpToolName(called.name)) ||
                this.requiredToolNames.some((required) =>
                  called.name.endsWith(required)
                )
            );

            if (finalMessage) {
              // If user added pending messages after finalAnswer was called,
              // continue running to respond to that feedback instead of returning
              if (this.pendingUserMessages.length > 0) {
                this.log(
                  "finalAnswer called but pending user messages exist, continuing to respond to feedback"
                );
                messages.push(...this.pendingUserMessages);
                this.pendingUserMessages = [];
                this.updateCurrentThread(messages);
                return this.call(userInput, messages);
              }

              // Emit task completion event for plugins (like GitPlugin)
              this.events.emit(this.eventTypes.agentTaskComplete, {
                taskId:
                  this.currentTaskId ||
                  this.startTimeMs?.toString() ||
                  Date.now().toString(),
                result: finalMessage.content || "Done",
              });
              const doneMsg = finalMessage.content || "Done";

              // Ensure the final thread state (including the finalAnswer result) is
              // captured before emitting done, so syncers see the complete thread.
              this.updateCurrentThread(messages);
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
      // Auto-detect termination words: if the model is just saying "Done", "Complete", etc.
      if (
        response.choices.length === 1 &&
        firstMessage.content &&
        this.isTerminationResponse(firstMessage.content)
      ) {
        this.log(
          `Termination word detected: "${firstMessage.content.trim()}", treating as finalAnswer`
        );
        this.status = this.eventTypes.done;
        this.agentEvents.emit(this.eventTypes.done, firstMessage.content);
        return firstMessage.content;
      }

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
        this.log(error, "error");
        this.status = this.eventTypes.done;
        this.agentEvents.emit(this.eventTypes.done, error);
        return error;
      }

      // Early exit: killed, agent was requested to wrap up
      if (
        this.pendingUserMessages.length === 0 &&
        this.status === this.eventTypes.kill
      ) {
        this.log("Agent killed, stopping execution");
        this.status = this.eventTypes.done;
        this.agentEvents.emit(this.eventTypes.done, firstMessage.content);
        return firstMessage.content;
      }

      // Compress when either the token threshold is exceeded OR the user has
      // manually requested compaction (e.g. via /compact on an attached agent).
      // A manual request bypasses the token threshold but still respects the
      // minimum-message guard so we never try to compress a tiny conversation.
      //
      // The size check uses getContextTokenCount(), which prefers the REAL
      // prompt token count from the last completion response over the
      // whitespace-based estimate — so it compares real tokens against the
      // real (token-based) compress threshold.
      const completedCompaction = this._completedCompaction;
      this._completedCompaction = null;
      let appliedCompaction = false;

      if (completedCompaction) {
        const currentPrefix = messages.slice(
          0,
          completedCompaction.compressionEnd
        );
        const prefixIsUnchanged = currentPrefix.every(
          (message, index) =>
            message === completedCompaction.originalPrefix[index] ||
            JSON.stringify(message) ===
              JSON.stringify(completedCompaction.originalPrefix[index])
        );

        if (
          currentPrefix.length === completedCompaction.compressionEnd &&
          prefixIsUnchanged
        ) {
          messages = [
            ...completedCompaction.replacementPrefix,
            ...messages.slice(completedCompaction.compressionEnd),
          ];
          this.summaries.push(completedCompaction.summary);
          this.startNewThread(messages);
          this.lastPromptTokens = 0;
          appliedCompaction = true;
        } else {
          this.log(
            "Discarding completed compaction because its source prefix changed; a later turn will retry",
            "warn"
          );
        }
      }

      const contextTokens = this.getContextTokenCount(messages);
      const overThreshold =
        contextTokens > this.getCompressThreshold() &&
        messages.length > this.compressMinMessages;

      if (
        !appliedCompaction &&
        !this._compactionPromise &&
        (overThreshold || this._forceCompact)
      ) {
        this.log(
          this._forceCompact
            ? `Starting background compaction (manual /compact request): ${contextTokens} tokens`
            : `Starting background compaction: ${contextTokens} tokens exceeds ${this.getCompressThreshold()}`
        );
        this._forceCompact = false;
        this.startBackgroundCompaction(messages);
      }

      if (["assistant", "tool"].includes(messages[messages.length - 1].role)) {
        // sometimes the agent just says a message and doesn't call a tool, or compression ends on a tool message

        const statusMessage = this.getStatusMessage();
        this.logStatus();

        const continuation = `<Workflow>
        This is an automated runtime instruction, not a new user message.
        The original user request remains active. Do not say that the user's
        message was empty, and do not ask the user to repeat the request.

        Your previous response did not terminate the task because it did not
        call one of the required tools: ${JSON.stringify(
          this.requiredToolNames
        )}.
        If your previous response was intended as the final response, call the
        appropriate required tool now with that response. Otherwise, continue
        working on the original request and call an appropriate required tool
        when the task is complete.

        <TaskStatus>${statusMessage}</TaskStatus>
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
        return this.call(userInput, _messages, retryCount);
      }
      const errorStr = e.toString();
      const isNonRetriable =
        errorStr.includes("401") ||
        errorStr.includes("403") ||
        errorStr.includes("404");

      const isRetriable =
        !isNonRetriable &&
        (errorStr.match(/5\d\d/) ||
          errorStr.includes("Failed to get models") ||
          errorStr.includes("timeout") ||
          errorStr.includes("ECONNRESET") ||
          errorStr.includes("ETIMEDOUT") ||
          errorStr.includes("Invalid response format from MCP"));

      if (isRetriable && retryCount < 3) {
        const delay = 1000 * Math.pow(2, retryCount);
        this.log(
          `Agent request failed (attempt ${
            retryCount + 1
          }/3), retrying in ${delay}ms: ${e.message}`,
          "warn"
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.call(userInput, _messages, retryCount + 1);
      }

      this.log(`Agent failed: ${e}`, "error");

      if (
        e != null &&
        typeof e === "object" &&
        "response" in e &&
        "data" in (e as any).response
      ) {
        this.log(
          `Error response data: ${JSON.stringify(e.response.data, null, 2)}`,
          "error"
        );
      }

      this.agentEvents.emit(this.eventTypes.done, e.message);
      return e.message;
    }
  }

  getStatusMessage() {
    const baseMessage = `Task spend: $${this.getTotalCostUsd().toPrecision(
      3
    )}\nElapsed: ${Math.floor(this.runTime() / 1000)}s\n`;

    const remainingTime =
      this.maxRunTimeMs && this.startTimeMs
        ? this.maxRunTimeMs - (Date.now() - this.startTimeMs)
        : null;

    const remainingTurns = this.maxTurns
      ? this.maxTurns - this.turnCount
      : null;

    const timeRemainingMsg = remainingTime
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

    const statusMessage = `${baseMessage}\n${timeRemainingMsg}\n${turnsRemainingMsg}\n${budgetRemainingMsg}`;
    return statusMessage;
  }

  logStatus() {
    const statusMessage = this.getStatusMessage();
    this.agentEvents.emit(this.eventTypes.agentStatus, {
      agentName: this.name,
      taskId: this.currentTaskId,
      statusMessage,
      details: {
        totalCostUsd: this.getTotalCostUsd(),
        elapsedMs: this.runTime(),
        remainingTimeMs:
          this.maxRunTimeMs && this.startTimeMs
            ? this.maxRunTimeMs - (Date.now() - this.startTimeMs)
            : undefined,
        remainingTurns: this.maxTurns
          ? this.maxTurns - this.turnCount
          : undefined,
        remainingBudget: this.maxSpend
          ? this.maxSpend - this.totalCostUsd
          : undefined,
      },
      timestamp: Date.now(),
    });
  }

  // A new message from system, non blocking
  addPendingMessage(message: Message) {
    if (this.status === this.eventTypes.done) {
      this.log("Agent is done, cannot take more messages", "warn");
    } else {
      const pendingMessages = this.pendingMessages.map((m) => m.content);
      if (pendingMessages.includes(message.content)) {
        // Ignore messages we already have queue'd up
        return;
      }
      this.pendingMessages.push(message);
    }
  }

  // A new message from users, blocks completion
  addPendingUserMessage(message: Message) {
    if (this.status === this.eventTypes.done) {
      this.log("Agent is done, cannot take more messages", "warn");
    } else {
      const pendingMessages = this.pendingUserMessages.map((m) => m.content);
      if (pendingMessages.includes(message.content)) {
        // Ignore messages we already have queue'd up
        return;
      }
      this.pendingUserMessages.push(message);
    }
    this.events.emit(this.eventTypes.userSay, message.content);
  }

  /**
   * Subscribe to any data-yielding source and stream its data into this agent's
   * loop as non-blocking pending messages. This is the unified subscription
   * primitive behind the `observe` tool — a tool poll, an event, a stream, a
   * peer agent's thread, a file tail, etc. all become `ObservationSource`
   * adapters feeding the same sink (`addPendingMessage`).
   *
   * Returns an observation id that can be passed to `stopObserving`. Auto-expires
   * after `maxUpdates` or `maxDurationMs` so a forgotten observer never leaks.
   */
  observe(source: ObservationSource, opts: ObserveOpts = {}): string {
    const {
      onlyOnChange = true,
      maxUpdates = 20,
      maxDurationMs = 10 * 60 * 1000,
    } = opts;

    this._observationSeq += 1;
    // Keep the id free of characters that would break id-extraction regexes
    // (labels can contain parens, spaces, JSON, etc).
    const safeLabel = source.label.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 24);
    const id = `obs_${safeLabel}_${Date.now()}_${this._observationSeq}`;
    let last: string | undefined;

    const emit = (datum: unknown) => {
      // status gate: don't inject once the agent is done
      if (this.status === this.eventTypes.done) {
        this.stopObserving(id);
        return;
      }
      const str = typeof datum === "string" ? datum : JSON.stringify(datum);
      if (onlyOnChange && str === last) return; // dedupe noise
      last = str;
      const obs = this._observations.get(id);
      if (!obs) return;
      obs.updates += 1;
      this.addPendingMessage({
        role: "user",
        content: `[observe:${id}] ${source.label} (update ${obs.updates}/${maxUpdates}):\n${str}`,
      });
      if (obs.updates >= maxUpdates) {
        this.stopObserving(id, "max updates reached");
      }
    };

    const teardownPromise = Promise.resolve(source.start(emit)).catch((e) => {
      this.log(
        `observe(${source.label}) start failed: ${e?.message ?? e}`,
        "warn"
      );
      return undefined;
    });

    const expiry = maxDurationMs
      ? setTimeout(
          () => this.stopObserving(id, "max duration reached"),
          maxDurationMs
        )
      : undefined;
    if (expiry && typeof (expiry as any).unref === "function") {
      (expiry as any).unref();
    }

    this._observations.set(id, {
      id,
      label: source.label,
      updates: 0,
      teardownPromise,
      expiry,
    });
    return id;
  }

  /**
   * Cancel one observation (by id) or all of them (no id). Companion to
   * `observe`. Runs each source's teardown function if it returned one.
   */
  stopObserving(id?: string, reason = "stopped"): string {
    const ids = id ? [id] : [...this._observations.keys()];
    let stopped = 0;
    for (const oid of ids) {
      const obs = this._observations.get(oid);
      if (!obs) continue;
      if (obs.expiry) clearTimeout(obs.expiry);
      Promise.resolve(obs.teardownPromise)
        .then((fn) => {
          if (typeof fn === "function") fn();
        })
        .catch(() => {});
      this._observations.delete(oid);
      stopped += 1;
    }
    return id
      ? stopped
        ? `Stopped observer ${id} (${reason}).`
        : `No active observer found with id: ${id}.`
      : `Stopped ${stopped} active observer(s) (${reason}).`;
  }

  getMessagesLength(messages: Message[]) {
    return JSON.stringify(messages).split(" ").length;
  }

  /**
   * Returns the best available estimate of how many tokens the current
   * conversation occupies in the model's context window, for the purpose of
   * deciding when to compact.
   *
   * Prefers the REAL prompt token count reported by the most recent completion
   * response (lastPromptTokens) — this is exactly how many tokens the model
   * consumed for the last request (fresh input + cache read + cache write), so
   * it is far more accurate than the whitespace-based getMessagesLength()
   * heuristic (which counts space-separated chunks of the JSON-stringified
   * messages and can be off by a large factor).
   *
   * Falls back to the whitespace estimate when no real usage has been observed
   * yet (e.g. before the first completion, or when a provider omits usage).
   *
   * Note: lastPromptTokens reflects the context size at the START of the last
   * request, so it lags by whatever the model generated + tool results appended
   * since then. That lag is intentionally covered by the 70% headroom baked
   * into getCompressThreshold().
   */
  getContextTokenCount(messages: Message[]): number {
    if (this.lastPromptTokens > 0) {
      return this.lastPromptTokens;
    }
    return this.getMessagesLength(messages);
  }

  /**
   * Detects whether tool call arguments appear truncated due to hitting the output token limit.
   * Two signals are checked:
   *   1. Any tool call argument is empty or invalid JSON (hard truncation).
   *   2. The model reported many output tokens but the total argument content received is tiny
   *      relative to what those tokens should represent (soft/silent truncation).
   *
   * @param toolCalls - The tool calls from the CURRENT choice being checked.
   * @param allToolCalls - ALL tool calls across ALL choices in the response (used for the size heuristic).
   * Returns a warning system message if truncation is detected, or null otherwise.
   */
  detectTruncatedToolCalls(
    toolCalls: ToolCall[],
    response: CompletionResponse,
    allToolCalls?: ToolCall[]
  ): { role: string; content: string } | null {
    // Subtract thinking/reasoning tokens — they're billed as output tokens but
    // don't produce visible argument content, so including them inflates the heuristic.
    const rawOutputTokens: number = response?.usage?.completion_tokens || 0;
    const thinkingTokens: number =
      (response?.usage?.output_tokens_details?.thinking_tokens ?? 0) +
      (response?.usage?.output_tokens_details?.reasoning_tokens ?? 0);
    const outputTokens = Math.max(0, rawOutputTokens - thinkingTokens);
    // Use allToolCalls for the size heuristic so that parallel tool calls from
    // Anthropic (each mapped to a separate choice) are counted together. Without
    // this, a response with N parallel tool calls would compare the full
    // completion_tokens count against only 1/N of the actual argument content,
    // causing false-positive truncation warnings.
    const callsForSizeCheck = allToolCalls ?? toolCalls;
    const totalArgLength = callsForSizeCheck.reduce(
      (sum, tc) => sum + (tc.function?.arguments?.length || 0),
      0
    );

    // Percentage-based heuristic: if actual arg chars are less than ~10% of the
    // expected chars (outputTokens * 4 chars/token), the output was likely truncated.
    // Only apply when outputTokens > 1000 to avoid false positives on small responses.
    const expectedArgChars = outputTokens * 4;
    const suspiciouslySmallArgs =
      outputTokens > 1000 && totalArgLength < expectedArgChars * 0.1;

    for (const toolCall of toolCalls) {
      const args = toolCall.function?.arguments || "";
      let isInvalidJson = false;
      try {
        JSON.parse(args);
      } catch {
        isInvalidJson = true;
      }
      if (isInvalidJson || args.trim() === "" || suspiciouslySmallArgs) {
        this.log(
          `Tool call '${toolCall.function?.name}' has malformed/truncated arguments — likely hit output token limit (outputTokens=${outputTokens}, argLength=${args.length})`,
          "warn"
        );
        return {
          role: "user",
          content:
            "⚠️ Output limit warning: Your last tool call had incomplete or missing arguments, which usually means you exceeded the output token limit mid-response. The model reported " +
            outputTokens +
            " output tokens but only " +
            totalArgLength +
            " characters of tool call arguments were received. Please write smaller, more concise content in your tool calls. Aim for no more than 4000 tokens of output per response. Break large responses into smaller pieces if needed.",
        };
      }
    }

    return null;
  }

  extractContentFromMessages(messages: Message[]): string {
    const content = messages
      .filter((m) => typeof m.content === "string" && m.content.trim())
      .map((m) => m.content);

    const finalAnswer = messages
      .filter((m) => m.tool_calls?.length)
      .flatMap((t) => t.tool_calls)
      .filter((t) => t.function.name === "finalAnswer")
      .map((t) => t.function.arguments);

    return [...content, ...finalAnswer].join("\n\n");
  }

  private startBackgroundCompaction(messages: Message[]): void {
    const snapshot = messages.slice();
    let resumeIndex = snapshot.length - 1;
    while (resumeIndex >= 0 && snapshot[resumeIndex].role !== "assistant") {
      resumeIndex--;
    }
    const compressionEnd =
      resumeIndex === -1 ? snapshot.length : resumeIndex;
    const generation = this._compactionGeneration;

    const promise = (async () => {
      const taskBreakdown = await this.getTaskBreakdown(snapshot, false);
      if (generation !== this._compactionGeneration) return;
      this.taskBreakdown = taskBreakdown;
      let summary = "";
      const compactedSnapshot = await this.compressMessages(
        snapshot,
        (generatedSummary) => {
          summary = generatedSummary;
        },
        taskBreakdown
      );
      if (generation !== this._compactionGeneration) return;

      const preservedSnapshotLength = snapshot.length - compressionEnd;
      this._completedCompaction = {
        compressionEnd,
        originalPrefix: snapshot.slice(0, compressionEnd),
        replacementPrefix: compactedSnapshot.slice(
          0,
          compactedSnapshot.length - preservedSnapshotLength
        ),
        summary,
      };
      this.log("Background compaction completed; it will be applied next turn");
    })();

    this._compactionPromise = promise;
    promise
      .catch((error) => {
        if (generation === this._compactionGeneration) {
          this.log(
            `Background compaction failed; a later turn will retry: ${error}`,
            "warn"
          );
        }
      })
      .finally(() => {
        if (this._compactionPromise === promise) {
          this._compactionPromise = null;
        }
      });
  }

  async getTaskBreakdown(messages: Message[], cacheResult = true) {
    if (this.taskBreakdown) {
      return this.taskBreakdown;
    }

    const taskPrompt = `
    TASK INTERRUPT. CONTEXT COMPACTION NEEDED. Analyze all previous messages.

    Generate a detailed task breakdown for this conversation, include a section for the following:
    1. Task List
    2. Completion Criteria - when the agent should stop

    Your output will be used to guide the work of the agent, and determine when we've accomplished the goal
    `;

    const model = this.getModel();

    const taskBreakdownMessages = [
      ...messages,
      {
        role: "user",
        content: taskPrompt,
      },
    ] as Message[];

    const response = await this.createAgentCompletion(
      {
        messages: taskBreakdownMessages,
        tool_choice: "none",
      },
      { updateLastPromptTokens: false }
    );

    const breakdownContent = this.extractContentFromMessages(
      response.choices?.map((c) => c.message)
    );
    // The model may return null content (e.g. when it responds with tool calls
    // instead of text). Guard against storing a literal null so that template
    // strings don't render "null".
    if (!breakdownContent) {
      console.log(JSON.stringify(response.choices, null, 2));
      throw new Error(
        "Compaction task-breakdown request returned no text content"
      );
    }

    if (cacheResult) {
      this.taskBreakdown = breakdownContent;
    }
    this.log(`task breakdown cost: ${response.usd_cost}`);
    return breakdownContent;
  }

  async compressMessages(
    messages: Message[],
    onSummary?: (summary: string) => void,
    taskBreakdown = this.taskBreakdown
  ) {
    // Preserve the latest agent interaction exactly. Starting the resumed thread
    // at the final assistant message keeps its tool calls, every tool response,
    // and any subsequent user messages together as one protocol-valid unit.
    let resumeIndex = messages.length - 1;
    while (resumeIndex >= 0 && messages[resumeIndex].role !== "assistant") {
      resumeIndex--;
    }
    const compressionEnd = resumeIndex === -1 ? messages.length : resumeIndex;
    const toCompress = messages.slice(0, compressionEnd);
    const resumeMessages = messages.slice(compressionEnd);

    this.log(
      `Compressing messages from 0 to ${compressionEnd}, resuming from ${resumeIndex}, total messages: ${messages.length}`
    );
    const toCompressPrompt = `TASK INTERRUPT. CONTEXT COMPACTION NEEDED.
    We are compressing our conversation to save memory.
    Please summarize the conversation so far, so that we may continue the original task with a smaller context

    Include the following sections:
    1. Initial Request - what this agent was originally tasked with.
    2. Progress - what has been tried so far,
    3. Next Steps - what we're about to do next to continue the user's original request.
    4. Tasks remaining - what tasks are left from the initial task breakdown.

    ${
      taskBreakdown
        ? `Our initial task breakdown: ${taskBreakdown}`
        : ""
    }

    This summary will replace the older history. The latest agent interaction will remain verbatim:

      `;

    const compressMessagesPayload = [
      ...toCompress,
      {
        role: "user",
        content: toCompressPrompt,
      },
    ] as Message[];

    const response = await this.createAgentCompletion(
      {
        messages: compressMessagesPayload,
        tool_choice: "none",
      },
      { updateLastPromptTokens: false }
    );

    const summary = this.extractContentFromMessages(
      response.choices?.map((c) => c.message)
    );

    if (summary.length === 0) {
      console.log(JSON.stringify(response.choices, null, 2));
      throw new Error("Compaction summary request returned no text content");
    }

    if (onSummary) {
      onSummary(summary);
    } else {
      this.summaries.push(summary);
    }

    const startMessages = [
      {
        role: "user",
        content: `
        ${
          taskBreakdown
            ? `Initial task breakdown:\n        ${taskBreakdown}`
            : "(No task breakdown available — summarize what you know from context above)"
        }

        We have just compressed the conversation to save memory:
        ${
          summary.length > 0
            ? JSON.stringify(summary)
            : "(summary unavailable — please continue from the task breakdown above)"
        }

        Please continue the task from where we left off
        `,
      },
    ] as Message[];
    const systemMessages = toCompress.filter((m) => m.role === "system");

    const newMessages = [
      ...systemMessages,
      ...startMessages,
      ...resumeMessages,
    ];

    const oldLength = this.getMessagesLength(messages);
    const newLength = this.getMessagesLength(newMessages);
    const compressionRatio = (
      ((oldLength - newLength) / oldLength) *
      100
    ).toFixed(2);

    this.log(`compression cost: ${response.usd_cost}`);
    this.log(
      `Compressed messages from ${oldLength} to ${newLength}, ${compressionRatio}% reduction in size`
    );

    return newMessages;
  }
}
