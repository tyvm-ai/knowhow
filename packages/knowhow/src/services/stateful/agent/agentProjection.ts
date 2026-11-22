import { messagesToRenderEvents } from "../../../chat/renderer/messagesToRenderEvents";
import { EventService } from "../../EventService";
import type { ProcessHandle, StateChange } from "../types";
import { isTerminalStatus } from "../types";
import type { AgentControl, AgentEvent, AgentState } from "./types";

export const PROJECTION_EVENT_TYPES = {
  done: "done",
  toolCall: "tool:pre_call",
  toolUsed: "tool:post_call",
  agentSay: "agent:say",
  threadUpdate: "thread_update",
};

const json = (m: unknown): string | null => {
  if (m == null) return null;
  try {
    return JSON.stringify(m);
  } catch {
    return null;
  }
};

/**
 * Finds the messages that are new in the LAST thread since the previous call.
 * Handles growth, a new thread (compaction) and a shrunk thread by locating
 * the last message it already saw. Written once for every medium (fs, web,
 * memory) — this replaces the diff that FsSyncer and RemoteSyncer duplicated.
 */
export class ThreadDiffer {
  private index = -1;
  private length = 0;
  private lastJson: string | null = null;

  constructor(threads: any[][] = []) {
    this.seed(threads);
  }

  /** Make `threads` the baseline (nothing in it is "new"). */
  seed(threads: any[][]) {
    const last = threads[threads.length - 1] ?? [];
    this.index = threads.length - 1;
    this.length = last.length;
    this.lastJson = json(last[last.length - 1]);
  }

  next(threads: any[][]): any[] {
    const last = threads[threads.length - 1] ?? [];
    const index = threads.length - 1;
    let fresh: any[] = [];
    if (index === this.index && last.length >= this.length) {
      fresh = last.slice(this.length);
    } else if (index > this.index && this.index >= 0 && this.isPrevThreadIntact(threads)) {
      // New thread(s) appeared (compaction / resume). First the unseen tail of
      // the thread we were following, then any threads in between, then the
      // new last thread — skipping what the new thread carried over from the
      // previous one (compaction keeps a suffix of it).
      const prev = threads[this.index] ?? [];
      fresh.push(...prev.slice(this.length));
      for (let i = this.index + 1; i < index; i++) fresh.push(...(threads[i] ?? []));
      const prevLastJson = index - 1 === this.index ? json(prev[prev.length - 1]) : null;
      fresh.push(...last.slice(this.retainedIndex(last, prevLastJson) + 1));
    } else {
      fresh = last.slice(this.retainedIndex(last, this.lastJson) + 1);
    }
    this.seed(threads);
    return fresh;
  }

  /** The thread we were following still starts with what we saw. */
  private isPrevThreadIntact(threads: any[][]): boolean {
    const prev = threads[this.index];
    if (!prev || prev.length < this.length) return false;
    if (this.length === 0 || this.lastJson == null) return true;
    return json(prev[this.length - 1]) === this.lastJson;
  }

  /** Index of the last message in `thread` equal to `target`, or -1. */
  private retainedIndex(thread: any[], target: string | null): number {
    if (target == null) return -1;
    for (let i = thread.length - 1; i >= 0; i--) {
      if (json(thread[i]) === target) return i;
    }
    return -1;
  }

  get state() {
    return { index: this.index, length: this.length, lastJson: this.lastJson };
  }
}

/**
 * Projects a process handle (mirror or live session) onto the legacy agent
 * event vocabulary (agent:say / tool:pre_call / tool:post_call / thread_update /
 * done), diffing the thread state. Returns an unsubscribe.
 */
export function agentProjection(
  handle: ProcessHandle<AgentState, AgentControl, AgentEvent>,
  events: EventService,
  opts: { types?: typeof PROJECTION_EVENT_TYPES; onDone?: (result: unknown) => void } = {}
): () => void {
  const types = opts.types ?? PROJECTION_EVENT_TYPES;
  const differ = new ThreadDiffer(handle.getState()?.threads ?? []);
  let finished = false;

  const onChange = (_c: StateChange<AgentState, AgentEvent>) => {
    if (finished) return;
    const state = handle.getState();
    const fresh = differ.next(state.threads ?? []);
    if (fresh.length) {
      const taskId = handle.meta.id;
      for (const ev of messagesToRenderEvents(fresh, taskId, state.agentName)) {
        if (ev.type === "toolCall") {
          events.emit(types.toolCall, { toolCall: (ev as any).toolCall });
        } else if (ev.type === "toolResult") {
          events.emit(types.toolUsed, {
            toolCall: (ev as any).toolCall,
            functionResp: (ev as any).result,
          });
        } else if (ev.type === "agentMessage") {
          events.emit(types.agentSay, { message: (ev as any).message });
        }
      }
      const threads = state.threads ?? [];
      events.emit(types.threadUpdate, threads[threads.length - 1] ?? []);
    }
    const lifecycle = handle.getLifecycle();
    if (isTerminalStatus(lifecycle.status)) {
      const result = lifecycle.result ?? state.result;
      if (lifecycle.status !== "failed" && result != null) {
        finished = true;
        events.emit(types.done, result);
        opts.onDone?.(result);
      } else if (lifecycle.status !== "running") {
        finished = true;
        opts.onDone?.(undefined);
      }
    }
  };
  return handle.onStateUpdated(onChange);
}
