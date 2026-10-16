import type { BaseAgent, ModelPreference } from "../../../agents/base/base";
import type { Message } from "../../../clients/types";
import { rollbackAgentInteractions } from "../../../agents/historyRollback";
import { applyDefaultMessageProcessors } from "../../../processors/defaultProcessors";
import type { Channel } from "../channels/Channel";
import { ResumableProcess } from "../ResumableProcess";
import {
  ControlChange,
  InputCursor,
  InputItem,
  ProcessCancelledError,
  ProcessDocument,
  isTerminalStatus,
} from "../types";
import type { AgentControl, AgentEvent, AgentPrompt, AgentState } from "./types";

export type AgentChannel = Channel<AgentState, AgentControl, AgentEvent>;

export interface AgentRunConfig {
  model?: string;
  provider?: string;
  modelPreferences?: ModelPreference[];
  reasoningEffort?: any;
  summarizeReasoning?: boolean;
  enabledTools?: string[];
}

export interface AgentSessionOptions {
  agent: BaseAgent;
  taskId: string;
  parentTaskId?: string;
  name?: string;
  prompt: AgentPrompt;
  /** What `state.prompt` / metadata.json record (default: the prompt itself). */
  displayPrompt?: string;
  runConfig?: AgentRunConfig;
  /** "default" installs the standard message processors (idempotent). */
  processors?: "default" | ((agent: BaseAgent) => void);
  history?: {
    mode: "new" | "resume" | "fork";
    threads?: Message[][];
    rollbackInteractions?: number;
    /** Use these messages as the request context verbatim. */
    requestContext?: Message[];
  };
  limits?: { maxRunTimeMs?: number; maxSpendUsd?: number; maxTurns?: number };
  channels?: AgentChannel[];
  /** State carried over from a previous run (input cursors, unprocessed messages). */
  restore?: Partial<Pick<AgentState, "inputCursors" | "pendingUserMessages">>;
}

const promptText = (p: AgentPrompt): string =>
  typeof p === "string" ? p : JSON.stringify(p);

/**
 * Build the request messages of a resumed/forked run: the last thread (after
 * rolling back whole interactions), with the resume prompt appended to the last
 * plain user message (or added as a new one).
 */
export function buildResumeMessages(
  threads: Message[][],
  rollbackInteractions: number,
  resumePrompt: string
): Message[] {
  const normalized: Message[][] =
    threads.length > 0 && !Array.isArray(threads[0])
      ? [threads as unknown as Message[]]
      : threads;
  const rolledBack = rollbackAgentInteractions(normalized, rollbackInteractions);
  const last = rolledBack.length ? rolledBack[rolledBack.length - 1] : [];
  const messages = [...last];
  const reversed = [...messages]
    .reverse()
    .findIndex((m) => m.role === "user" && typeof m.content === "string");
  if (reversed === -1) {
    messages.push({ role: "user", content: resumePrompt });
  } else {
    const i = messages.length - 1 - reversed;
    messages[i] = {
      ...messages[i],
      content: `${messages[i].content}\n\n<Workflow>[RESUME CONTEXT]: ${resumePrompt}</Workflow>`,
    };
  }
  return messages;
}

const itemText = (item: InputItem): string => {
  const p: any = item.payload;
  if (typeof p === "string") return p;
  if (typeof p?.text === "string") return p.text;
  return JSON.stringify(p ?? "");
};

/**
 * One agent run as a StatefulProcess. BaseAgent keeps its inference loop and
 * `agentEvents`; the session binds to it: agent events -> state/events,
 * control -> agent pause/unpause/kill/interrupt, inputs -> pending user
 * messages (cursor saved in the same version). No renderer, no askHuman, no
 * SessionManager, no child spawning: those stay in callers.
 */
export class AgentSession extends ResumableProcess<AgentState, AgentControl, AgentEvent> {
  readonly agent: BaseAgent;
  private opts: AgentSessionOptions;
  private messages?: Message[];
  private agentPaused = false;
  private finalizing?: Promise<void>;
  private unbind: Array<() => void> = [];
  private started = false;

  private constructor(opts: AgentSessionOptions) {
    super({
      id: opts.taskId,
      kind: "agent",
      name: opts.name ?? opts.agent.name,
      parentId: opts.parentTaskId,
      lifecycle: { resumable: "replay" },
      state: {
        agentName: opts.agent.name,
        model: opts.agent.getModel?.(),
        provider: opts.agent.getProvider?.(),
        enabledTools: [],
        threads: [],
        totalCostUsd: 0,
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
        },
        prompt: opts.displayPrompt ?? promptText(opts.prompt),
        pendingUserMessages: [],
        inputCursors: {},
      },
    });
    this.agent = opts.agent;
    this.opts = opts;
  }

  /** Configure the agent (run config, processors, limits, history), bind to it and attach the channels. */
  static async create(opts: AgentSessionOptions): Promise<AgentSession> {
    const s = AgentSession.createSync(opts);
    for (const ch of opts.channels ?? []) await s.attach(ch);
    return s;
  }

  /**
   * Everything `create` does except attaching `opts.channels` (attach them
   * yourself with `await session.attach(ch)`). For callers that must start the
   * agent synchronously, e.g. the in-process interactive handle.
   */
  static createSync(opts: AgentSessionOptions): AgentSession {
    const s = new AgentSession(opts);
    s.configureAgent();
    s.bindAgent();
    s.replaceState(s.copyFromAgent(s.getState() as AgentState, true), {
      reason: "init",
    });
    return s;
  }

  private configureAgent() {
    const { agent, runConfig: rc, limits, history } = this.opts;
    if (rc?.enabledTools) agent.restoreEnabledTools(rc.enabledTools);
    if (rc?.model) {
      agent.setModel(rc.model);
      agent.setModelPreferences(
        rc.modelPreferences ?? [{ model: rc.model, provider: rc.provider as any }]
      );
    } else if (rc?.modelPreferences) {
      agent.setModelPreferences(rc.modelPreferences);
    }
    if (rc?.provider) agent.setProvider(rc.provider as any);
    if (rc?.reasoningEffort !== undefined) agent.setReasoningEffort(rc.reasoningEffort);
    if (rc?.summarizeReasoning !== undefined) {
      agent.setSummarizeReasoning(rc.summarizeReasoning);
    }
    if (this.opts.processors === "default") applyDefaultMessageProcessors(agent);
    else if (typeof this.opts.processors === "function") this.opts.processors(agent);

    if (limits?.maxRunTimeMs) agent.setMaxRunTime(limits.maxRunTimeMs);
    if (limits?.maxSpendUsd) agent.setMaxSpend(limits.maxSpendUsd);
    if (limits?.maxTurns) agent.setMaxTurns(limits.maxTurns);

    agent.newTask(this.opts.taskId);
    if (this.opts.parentTaskId) agent.setParentTaskId?.(this.opts.parentTaskId);

    if (history?.requestContext) {
      this.messages = history.requestContext;
    } else if (history && history.mode !== "new" && history.threads) {
      this.messages = buildResumeMessages(
        history.threads,
        history.rollbackInteractions ?? 0,
        this.opts.displayPrompt ?? promptText(this.opts.prompt)
      );
    }

    const restore = this.opts.restore;
    if (restore?.pendingUserMessages?.length) {
      for (const m of restore.pendingUserMessages) agent.addPendingUserMessage(m);
    }
  }


  // ---- agent -> state -------------------------------------------------------

  private snapshotThreads(): Message[][] {
    const threads = this.agent.getThreads?.() ?? [];
    try {
      return structuredClone(threads);
    } catch {
      return JSON.parse(JSON.stringify(threads));
    }
  }

  private copyFromAgent(prev: AgentState, init = false): AgentState {
    const a = this.agent;
    const unplaced = a.getPendingUserMessageCount?.() ?? 0;
    const restore = this.opts.restore;
    return {
      ...prev,
      agentName: a.name,
      model: a.getModel?.() ?? prev.model,
      provider: a.getProvider?.() ?? prev.provider,
      reasoningEffort: a.getReasoningEffort?.() as string | undefined,
      summarizeReasoning: a.getSummarizeReasoning?.(),
      enabledTools: a.getEnabledToolNames?.() ?? prev.enabledTools,
      threads: this.snapshotThreads(),
      totalCostUsd: a.getTotalCostUsd?.() ?? prev.totalCostUsd,
      tokenUsage: { ...(a.getTokenUsage?.() ?? prev.tokenUsage) },
      // once the agent has moved them into the thread they are no longer "pending"
      pendingUserMessages: init
        ? [...(restore?.pendingUserMessages ?? [])]
        : unplaced === 0
          ? []
          : prev.pendingUserMessages,
      inputCursors: init ? { ...(restore?.inputCursors ?? {}) } : prev.inputCursors,
    };
  }

  private bindAgent() {
    const a = this.agent;
    const t = a.eventTypes;
    const on = (event: string | undefined, fn: (...args: any[]) => void) => {
      if (!event) return; // minimal agents may not define every event type
      a.agentEvents.on(event, fn);
      this.unbind.push(() => a.agentEvents.removeListener(event, fn));
    };
    on(t.threadUpdate, () =>
      this.replaceState(this.copyFromAgent(this.getState() as AgentState), {
        reason: "thread_update",
      })
    );
    on(t.agentSay, (d: any) => {
      if (typeof d?.message === "string") this.emit({ type: "say", message: d.message });
    });
    on(t.toolCall, (d: any) => this.emit({ type: "tool_call", toolCall: d?.toolCall }));
    on(t.toolUsed, (d: any) =>
      this.emit({ type: "tool_result", toolCall: d?.toolCall, result: d?.functionResp })
    );
    on(t.tokenUsage, (usage: any) => this.emit({ type: "usage", usage }));
    on(t.done, (result: any) => void this.finalize(result ?? ""));
    // pause/kill requested directly on the agent (local /pause, /kill): mirror into control
    on(t.pause, () => {
      this.agentPaused = true;
      if (this.getLifecycle().status === "running") this.setStatus("paused");
      if (this.getControl().desired !== "paused") {
        this.applyControl({ desired: "paused" }, "agent");
      }
    });
    on(t.unpause, () => {
      this.agentPaused = false;
      if (this.getLifecycle().status === "paused") this.setStatus("running");
      if (this.getControl().desired === "paused") {
        this.applyControl({ desired: "running" }, "agent");
      }
    });
    on(t.kill, () => {
      if (this.getControl().desired !== "cancelled") {
        this.applyControl({ desired: "cancelled" }, "agent");
      }
    });
  }

  // ---- control -> agent ---------------------------------------------------------

  protected onPause() {
    if (!this.agentPaused) this.agent.pause();
    if (this.getLifecycle().status !== "paused") this.setStatus("paused");
  }
  protected onResume() {
    if (this.agentPaused) this.agent.unpause();
  }
  protected async onCancel() {
    await this.agent.kill();
  }
  protected onInterrupt(message?: string) {
    this.agent.interrupt(message);
  }
  protected onControl(change: ControlChange<AgentControl>) {
    const { prev, next } = change;
    if (next.maxSpendLimit !== prev.maxSpendLimit && next.maxSpendLimit !== undefined) {
      this.agent.setMaxSpend(next.maxSpendLimit);
    }
    if (next.compact?.id && next.compact.id !== prev.compact?.id) {
      this.agent.requestCompact();
      this.agent.interrupt();
    }
  }

  // ---- inputs -> agent ------------------------------------------------------

  protected onInput(items: InputItem[], cursor: InputCursor) {
    const queued: Message[] = [];
    const queue = (m: Message) => {
      this.agent.addPendingUserMessage(m);
      queued.push(m);
    };
    for (const item of items) {
      const payload: any = item.payload;
      const text = itemText(item);
      const from = item.from ? `[from:${item.from}] ` : "";
      if (item.kind === "interrupt") {
        this.interruptWith(text || undefined, queued);
      } else if (text.trim().startsWith("/")) {
        // commands apply to their own message only
        const [command, ...rest] = text.trim().split(" ");
        const message = rest.join(" ").trim() || undefined;
        if (command === "/poke") {
          this.interruptWith(message, queued);
        } else if (command === "/compact") {
          this.agent.requestCompact();
          this.agent.interrupt();
        } else {
          queue({ role: "user", content: text.trim() });
        }
      } else {
        queue({
          role: payload?.role === "assistant" ? "assistant" : "user",
          // structured content (e.g. multimodal parts) is passed through untouched
          content: payload?.content !== undefined && typeof payload.content !== "string" ? payload.content : from + text,
        });
      }
    }
    this.consume(items, cursor, (draft) => {
      draft.pendingUserMessages.push(...queued);
    });
  }

  private interruptWith(message: string | undefined, queued: Message[]) {
    // agent.interrupt() queues a real message as a pending user message itself
    if (message) queued.push({ role: "user", content: message });
    this.agent.interrupt(message);
  }

  /** Convenience for in-process senders. */
  sendMessage(text: string, from?: string): InputItem {
    return this.send("message", { text }, { from });
  }

  // ---- lifecycle ------------------------------------------------------------------

  /** Run the agent loop (fresh run, or the resumed/forked history). */
  async start(): Promise<string> {
    if (this.started) throw new Error(`AgentSession ${this.meta.id} already started`);
    this.started = true;
    try {
      this.setStatus("running", {
        executor: {
          host: require("os").hostname(),
          pid: process.pid,
          heartbeatAt: new Date().toISOString(),
        },
      });
      await this.checkpoint();
      const result = await this.agent.call(this.opts.prompt, this.messages);
      await this.finalize(result ?? "");
      return result;
    } catch (e: any) {
      if (!isTerminalStatus(this.getLifecycle().status)) {
        if (e instanceof ProcessCancelledError) this.setStatus("cancelled");
        else {
          this.setStatus("failed", {
            error: { message: e?.message ?? String(e), stack: e?.stack },
          });
        }
      }
      await this.flush();
      throw e;
    }
  }

  protected async resumeFrom(doc: ProcessDocument<AgentState, AgentControl>) {
    this.messages = buildResumeMessages(doc.state.threads, 0, doc.state.prompt);
    return this.start();
  }

  private finalize(result: string): Promise<void> {
    if (this.finalizing) return this.finalizing;
    this.finalizing = (async () => {
      if (isTerminalStatus(this.getLifecycle().status)) return;
      this.replaceState(
        { ...this.copyFromAgent(this.getState() as AgentState), result },
        { reason: "done" }
      );
      const cancelled = this.getControl().desired === "cancelled";
      this.setStatus(cancelled ? "cancelled" : "completed", { result });
      await super.flush();
    })();
    return this.finalizing;
  }

  /** Waits for finalization (done event) and every channel. */
  async flush(): Promise<void> {
    await this.finalizing;
    await super.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    for (const off of this.unbind.splice(0)) off();
    await super.close();
  }
}
