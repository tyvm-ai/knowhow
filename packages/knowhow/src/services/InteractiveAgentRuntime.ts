import { randomUUID } from "crypto";
import { MessageContent } from "../clients/types";
import { IAgent } from "../agents/interface";
import { EventService } from "./EventService";
import type { BaseAgent } from "../agents/base/base";
import { AgentSession } from "./stateful/agent/AgentSession";
import type { AgentChannel } from "./stateful/agent/AgentSession";
import type { AgentEvent, AgentState } from "./stateful/agent/types";
import type { StateChange } from "./stateful/types";

export interface AgentInput {
  id: string;
  kind: "user" | "observation" | "control";
  content: string | MessageContent[];
  timestamp: number;
  correlationId?: string;
  interrupt?: boolean;
  metadata?: Record<string, unknown>;
}

export type AgentRuntimeEvent =
  | { type: "output.completed"; generationId: string; text: string }
  | { type: "tool.started"; toolCallId: string; name: string }
  | { type: "tool.completed"; toolCallId: string; name: string; committed: boolean }
  | { type: "cost.updated"; costUsd: number }
  | { type: "status"; status: "running" | "paused" | "done" | "failed" }
  | { type: "final"; answer: string };

export interface InteractiveAgentResult {
  answer: string;
  costUsd: number;
}

export interface InteractiveAgentHandle {
  readonly taskId: string;
  send(input: AgentInput): Promise<void>;
  interrupt(input: AgentInput): Promise<void>;
  events(signal?: AbortSignal): AsyncIterable<AgentRuntimeEvent>;
  stop(reason?: string): Promise<void>;
  readonly done: Promise<InteractiveAgentResult>;
}

export interface StartInteractiveAgentOptions {
  initialInput: AgentInput;
  taskId?: string;
  signal?: AbortSignal;
  /**
   * Memory only by default. Pass channels (e.g. `agentChannels({ taskId })`) to
   * sync the task to the filesystem / knowhow-web so it can be attached from
   * another terminal.
   */
  channels?: AgentChannel[];
}

/** The subset of BaseAgent used by the interactive transport. */
export interface InteractiveAgent extends IAgent {
  agentEvents: EventService;
  eventTypes: {
    agentSay: string;
    toolCall: string;
    toolUsed: string;
    pause: string;
    unpause: string;
    done: string;
    [key: string]: string;
  };
  newTask(taskId?: string): void;
  addPendingUserMessage(message: { role: "user"; content: any }): void;
  interrupt(message?: string): void;
  kill(): Promise<void>;
  status?: string;
  unpause?(): void;
  getTotalCostUsd?(): number;
}

function inputText(input: AgentInput): string {
  if (typeof input.content === "string") return input.content;
  return JSON.stringify(input.content);
}

class AsyncEventChannel<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as any, done: true });
    }
  }

  iterable(signal?: AbortSignal): AsyncIterable<T> {
    const channel = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (signal?.aborted || (channel.closed && !channel.values.length)) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            const value = channel.values.shift();
            if (value !== undefined) {
              return Promise.resolve({ value, done: false });
            }
            return new Promise((resolve) => {
              const waiter = (result: IteratorResult<T>) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(result);
              };
              const onAbort = () => {
                const index = channel.waiters.indexOf(waiter);
                if (index >= 0) channel.waiters.splice(index, 1);
                waiter({ value: undefined as any, done: true });
              };
              signal?.addEventListener("abort", onAbort, { once: true });
              channel.waiters.push(waiter);
              // Cover an abort between next()'s initial check and listener setup.
              if (signal?.aborted) onAbort();
            });
          },
          return(): Promise<IteratorResult<T>> {
            return Promise.resolve({ value: undefined as any, done: true });
          },
        };
      },
    };
  }
}

/**
 * Task-scoped, transport-friendly view of an AgentSession (voice, WebSocket and
 * terminal transports use it without owning the agent loop). The session owns
 * the process half (inputs, control, lifecycle, channels); this class maps
 * session changes onto `AgentRuntimeEvent`s. Memory only: pass
 * `options.channels` (e.g. `agentChannels({ taskId })`) to also sync to fs/web,
 * which makes the task attachable from another terminal.
 */
export class BaseInteractiveAgentHandle implements InteractiveAgentHandle {
  readonly taskId: string;
  readonly done: Promise<InteractiveAgentResult>;
  readonly session: AgentSession;

  private readonly channel = new AsyncEventChannel<AgentRuntimeEvent>();
  private readonly unsubscribe: Array<() => void> = [];
  private generation = 0;
  private lastOutputText = "";
  private lastCostUsd = -1;
  private lastStatus: "running" | "paused" | "done" | "failed" = "running";
  private settled = false;
  private stopping = false;
  private abortCleanup?: () => void;

  constructor(
    private readonly agent: InteractiveAgent,
    options: StartInteractiveAgentOptions,
    private readonly onFinished?: () => void
  ) {
    this.taskId = options.taskId || randomUUID();
    this.session = AgentSession.createSync({
      agent: agent as unknown as BaseAgent,
      taskId: this.taskId,
      prompt: inputText(options.initialInput),
    });
    this.unsubscribe.push(
      this.session.onStateUpdated((change) => this.onChange(change))
    );
    this.channel.push({ type: "status", status: "running" });

    if (options.signal) {
      const signal = options.signal;
      const onAbort = () =>
        void this.stop("caller aborted the interactive task").catch(() => undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      this.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }

    this.done = this.run(options.channels);
  }

  events(signal?: AbortSignal): AsyncIterable<AgentRuntimeEvent> {
    return this.channel.iterable(signal);
  }

  async send(input: AgentInput): Promise<void> {
    this.ensureActive();
    if (input.interrupt) return this.interrupt(input);
    const structured = typeof input.content !== "string";
    this.session.send("message", {
      text: inputText(input),
      ...(structured ? { content: input.content } : {}),
    });
    await this.session.flush();
  }

  async interrupt(input: AgentInput): Promise<void> {
    this.ensureActive();
    this.session.interrupt(inputText(input));
    await this.session.flush();
  }

  async stop(reason = "user stopped the interactive task"): Promise<void> {
    if (this.settled || this.stopping) return;
    this.stopping = true;
    this.session.cancel(); // onCancel -> agent.kill()
    await this.session.flush();
    // kill() queues the wrap-up instruction (and releases BaseAgent's pause
    // waiter when needed). Use the default control signal so the human-facing
    // stop reason is not added as another user turn.
    this.agent.interrupt();
  }

  private pushStatus(status: "running" | "paused" | "done" | "failed"): void {
    if (status === this.lastStatus && status !== "running") return;
    this.lastStatus = status;
    this.channel.push({ type: "status", status });
  }

  /** session changes -> runtime events */
  private onChange(change: StateChange<AgentState, AgentEvent>): void {
    for (const event of change.events) {
      if (event.type === "say") {
        const text = event.message;
        if (typeof text === "string" && text.length) {
          this.lastOutputText = text;
          this.channel.push({
            type: "output.completed",
            generationId: `${this.taskId}:${++this.generation}`,
            text,
          });
          this.pushCost();
        }
      } else if (event.type === "tool_call") {
        this.channel.push({
          type: "tool.started",
          toolCallId: event.toolCall?.id || randomUUID(),
          name: event.toolCall?.function?.name || "unknown",
        });
      } else if (event.type === "tool_result") {
        this.channel.push({
          type: "tool.completed",
          toolCallId: event.toolCall?.id || randomUUID(),
          name: event.toolCall?.function?.name || "unknown",
          committed: true,
        });
        this.pushCost();
      }
    }
    if (change.reason === "status:paused") this.pushStatus("paused");
    else if (change.reason === "status:running" && this.lastStatus === "paused") {
      this.pushStatus("running");
    }
  }

  private async run(channels?: StartInteractiveAgentOptions["channels"]): Promise<InteractiveAgentResult> {
    try {
      if (this.stopping) {
        throw new Error("Interactive agent task was aborted before it started");
      }
      for (const ch of channels ?? []) await this.session.attach(ch);
      // Providers may resolve an aborted/budget-limited generation with null.
      // Normalize it so cancellation preserves the original error instead of
      // throwing a secondary `null.trim()` exception.
      const answer = ((await this.session.start()) as string | null) ?? "";
      const result = {
        answer,
        costUsd: this.agent.getTotalCostUsd?.() || 0,
      };
      this.pushCost(true);
      if (answer.trim() && answer !== this.lastOutputText) {
        this.lastOutputText = answer;
        this.channel.push({
          type: "output.completed",
          generationId: `${this.taskId}:${++this.generation}`,
          text: answer,
        });
      }
      this.channel.push({ type: "final", answer });
      this.pushStatus("done");
      return result;
    } catch (error) {
      this.pushStatus("failed");
      throw error;
    } finally {
      this.settled = true;
      for (const off of this.unsubscribe.splice(0)) off();
      this.channel.close();
      this.abortCleanup?.();
      await this.session.close().catch(() => undefined);
      this.onFinished?.();
    }
  }

  private ensureActive(): void {
    if (this.settled) throw new Error(`Interactive agent task ${this.taskId} is finished`);
  }

  private pushCost(force = false): void {
    const costUsd = this.agent.getTotalCostUsd?.() || 0;
    if (!force && costUsd === this.lastCostUsd) return;
    this.lastCostUsd = costUsd;
    this.channel.push({ type: "cost.updated", costUsd });
  }
}

export function isInteractiveAgent(agent: IAgent): agent is InteractiveAgent {
  const candidate = agent as any;
  return Boolean(
    candidate?.agentEvents &&
      candidate?.eventTypes &&
      typeof candidate.newTask === "function" &&
      typeof candidate.interrupt === "function" &&
      typeof candidate.addPendingUserMessage === "function" &&
      typeof candidate.kill === "function"
  );
}
