import * as fs from "fs";
import * as path from "path";
import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";
import { readInputBatch } from "../../services/stateful/channels/inputStream";

/** Resolve the agents dir lazily so tests (and cwd changes) are respected. */
function agentsDir(): string {
  return path.join(process.cwd(), ".knowhow", "processes", "agents");
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "error",
  "done",
]);

/**
 * Child statuses that mean "the child is blocked and probably needs the
 * parent's attention" — waitForAgentCompleted returns early (reason:
 * "child_status") instead of sitting there while the child waits on us.
 */
const ATTENTION_STATUSES = new Set([
  "waiting",
  "paused",
  "pausing",
  "needs-approval",
  "needs_approval",
  "needsApproval",
  "awaiting-approval",
  "awaiting_approval",
  "awaiting-input",
  "awaiting_input",
  "input-required",
  "input_required",
]);

export type WaitReason =
  | "completed"
  | "timeout"
  | "pending_message"
  | "child_status"
  | "user_interrupt";

interface AgentTaskResult {
  taskId: string;
  /** All task ids being waited on (only set when more than one / taskIds used). */
  taskIds?: string[];
  /** Latest status per waited task id (set for interrupted results). */
  statuses?: Record<string, string>;
  reason?: WaitReason;
  /** True when the wait returned early without the child finishing. */
  interrupted?: boolean;
  /** Human/agent readable hint about what to do next (interrupted results). */
  hint?: string;
  status: string;
  costUsd: number;
  finalAnswer?: string;
  artifacts?: string[];
  elapsedMs?: number;
  timedOut?: boolean;
  error?: string;
  remote?: boolean;
}

function readMeta(taskId: string): any | null {
  try {
    const metaPath = path.join(agentsDir(), taskId, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function readStatusFile(taskId: string): string | null {
  try {
    const statusPath = path.join(agentsDir(), taskId, "status.txt");
    if (!fs.existsSync(statusPath)) return null;
    return fs.readFileSync(statusPath, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Consolidated status read. metadata.status is the live/canonical value; the
 * status.txt file is a fallback signal. If metadata says the task is no longer
 * inProgress but has no explicit terminal status, treat it as completed.
 */
function resolveStatus(meta: any | null, statusFile: string | null): string {
  if (meta?.status) return meta.status;
  if (statusFile) return statusFile;
  if (meta && meta.inProgress === false) return "completed";
  return "unknown";
}

/** Extract the last assistant message from a thread as a fallback finalAnswer. */
export function lastAssistantText(threads: any): string | undefined {
  if (!threads) return undefined;
  // threads may be an array of message arrays, or a flat message array.
  let messages: any[] = [];
  if (Array.isArray(threads)) {
    if (threads.length && Array.isArray(threads[0])) {
      // array of threads — flatten
      messages = threads.flat();
    } else {
      messages = threads;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

/**
 * Check whether a process id is still alive. Used as a fallback liveness check
 * so we don't wait forever on a task whose process crashed without writing a
 * terminal status.
 */
function pidAlive(pid: number): boolean {
  try {
    // signal 0 doesn't kill — it only checks for existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = no such process. EPERM = exists but not ours (still alive).
    return e?.code === "EPERM";
  }
}

/**
 * Discover the pid of a spawned agent task. AgentFsChannel records the
 * agent subprocess's own `process.pid` into metadata.json, so we read the
 * `pid` (or legacy `processId`) field from there. If it's absent (e.g. an older
 * task created before this was persisted), we skip the liveness check.
 */
function metaPid(meta: any | null): number | undefined {
  const pid = meta?.pid ?? meta?.processId;
  return typeof pid === "number" ? pid : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WaitForAgentCompletedParams {
  /** The taskId of the agent to wait for. */
  taskId?: string;
  /**
   * Wait for the FIRST of several local children to finish. Combined with
   * `taskId` when both are given.
   */
  taskIds?: string[];
  /**
   * Return early (interrupted: true, reason "pending_message") as soon as the
   * calling agent has an unhandled incoming message (child replyToParent,
   * user message, /poke, remote message). Default true.
   */
  interruptOnMessages?: boolean;
  /**
   * Return early (reason "child_status") when a child is/enters
   * waiting/paused/needs-approval. Default true.
   */
  interruptOnChildStatus?: boolean;
  /** Max time to wait in milliseconds before returning timedOut. Default 30 min. */
  timeoutMs?: number;
  /** How often to poll status in milliseconds. Default 2000ms. */
  pollIntervalMs?: number;
  /** Force polling a remote (backend-synced) task by UUID. */
  remote?: boolean;
  _ctx?: ToolCallContext;
}

/**
 * Has the calling agent got an incoming message it has not handled yet?
 *
 * Inside an agent loop the input.txt channel (AgentSession) delivers records
 * into the agent's pending-message queues within ~250ms, so the in-memory
 * queues are the source of truth. Without a live caller (tests, scripts) we
 * fall back to peeking at the caller task's own input.txt for unread records.
 * Nothing is ever consumed here — the normal loop delivers it next turn.
 */
async function callerHasPendingMessage(
  ctx: ToolCallContext | undefined
): Promise<boolean> {
  const caller = ctx?.caller;
  if (caller && typeof caller.hasPendingMessages === "function") {
    try {
      if (caller.hasPendingMessages()) return true;
    } catch {
      /* ignore */
    }
    return false;
  }
  const callerTaskId = ctx?.taskId ?? caller?.currentTaskId;
  if (!callerTaskId) return false;
  try {
    const inputPath = path.join(agentsDir(), callerTaskId, "input.txt");
    if (!fs.existsSync(inputPath)) return false;
    const batch = await readInputBatch(inputPath, undefined, {
      includePartial: true,
    });
    return batch.items.length > 0;
  } catch {
    return false;
  }
}

function terminalResult(
  taskId: string,
  status: string,
  meta: any | null,
  start: number,
  extra: Partial<AgentTaskResult> = {}
): AgentTaskResult {
  return {
    taskId,
    status,
    reason: "completed",
    costUsd: meta?.totalCostUsd ?? 0,
    finalAnswer: meta?.result ?? lastAssistantText(meta?.threads),
    artifacts: meta?.artifacts,
    elapsedMs: Date.now() - start,
    ...extra,
  };
}

const INTERRUPT_HINTS: Record<string, string> = {
  pending_message:
    "You have a new incoming message (see your next turn). Handle it, then call waitForAgentCompleted again if you still need to wait for the child.",
  child_status:
    "A child is waiting/paused and may need your attention (e.g. sendAgentMessage to it). Handle it, then call waitForAgentCompleted again (pass interruptOnChildStatus:false to keep waiting through a waiting/paused child).",
  user_interrupt:
    "The wait was interrupted by the user. Call waitForAgentCompleted again if you still need to wait for the child.",
};

/**
 * Block until a spawned agent task reaches a terminal status, then return a
 * structured result: { status, costUsd, finalAnswer, artifacts, reason }.
 *
 * This is the native "join" primitive for orchestration — it must be a real
 * tool (not a script polling loop) because the script sandbox caps `sleep` and
 * burns a tool call per poll. It reads the consolidated status from
 * metadata.json / status.txt and falls back to a process-liveness check so a
 * crashed child doesn't hang the parent forever.
 *
 * The wait is interruptible: it also watches the CALLER's own pending message
 * queue (child replies, user messages, /poke, remote messages) and the
 * children's status, and returns early with `interrupted: true` so the
 * calling agent can react. Messages are only peeked at, never consumed.
 */
export async function waitForAgentCompleted(
  params: WaitForAgentCompletedParams
): Promise<string> {
  const {
    timeoutMs = 30 * 60 * 1000,
    pollIntervalMs = 2000,
    interruptOnMessages = true,
    interruptOnChildStatus = true,
    _ctx,
  } = params;

  const ids = Array.from(
    new Set(
      [params.taskId, ...(Array.isArray(params.taskIds) ? params.taskIds : [])]
        .filter((t): t is string => typeof t === "string" && t.length > 0)
    )
  );
  const taskId = ids[0];
  const multi = Array.isArray(params.taskIds) && ids.length > 1;

  if (!taskId) {
    return JSON.stringify({
      taskId: params.taskId,
      status: "error",
      costUsd: 0,
      error: "taskId is required for waitForAgentCompleted",
    } as AgentTaskResult);
  }

  const remoteMod = await import("../../services/RemoteWorkers");
  const isRemoteId = (id: string) =>
    params.remote === true ||
    (remoteMod.isRemoteTaskId(id) &&
      !fs.existsSync(path.join(agentsDir(), remoteMod.stripRemotePrefix(id))));

  if (multi && ids.some(isRemoteId)) {
    return JSON.stringify({
      taskId,
      taskIds: ids,
      status: "error",
      costUsd: 0,
      error:
        "taskIds only supports local agent tasks; wait for remote tasks one at a time with taskId",
    } as AgentTaskResult);
  }

  const signal: AbortSignal | undefined = _ctx?.signal;

  const interruptedResult = (
    reason: WaitReason,
    status: string,
    start: number,
    statuses: Record<string, string>,
    meta?: any
  ): AgentTaskResult => ({
    taskId,
    ...(multi ? { taskIds: ids } : {}),
    status,
    statuses,
    interrupted: true,
    reason,
    hint: INTERRUPT_HINTS[reason],
    costUsd: meta?.totalCostUsd ?? 0,
    elapsedMs: Date.now() - start,
  });

  if (isRemoteId(taskId)) {
    const remoteStart = Date.now();
    try {
      let interruptReason: WaitReason | undefined;
      const r = await remoteMod.waitForRemoteTask(
        remoteMod.stripRemotePrefix(taskId),
        {
          timeoutMs,
          pollIntervalMs,
          interruptCheck: async () => {
            if (signal?.aborted) return (interruptReason = "user_interrupt");
            if (interruptOnMessages && (await callerHasPendingMessage(_ctx))) {
              return (interruptReason = "pending_message");
            }
            return undefined;
          },
        }
      );
      if ((r as any).interrupted && interruptReason) {
        return JSON.stringify({
          ...interruptedResult(interruptReason, r.status, remoteStart, {
            [taskId]: r.status,
          }),
          costUsd: r.costUsd,
          remote: true,
        });
      }
      return JSON.stringify({
        taskId,
        status: r.status,
        reason: r.timedOut ? "timeout" : "completed",
        costUsd: r.costUsd,
        finalAnswer: r.finalAnswer,
        elapsedMs: r.elapsedMs,
        timedOut: r.timedOut,
        error: r.error,
        remote: true,
      } as AgentTaskResult);
    } catch (e: any) {
      return JSON.stringify({
        taskId,
        status: "error",
        costUsd: 0,
        error: `Remote wait failed: ${e?.message ?? String(e)}`,
        remote: true,
      } as AgentTaskResult);
    }
  }

  for (const id of ids) {
    if (!fs.existsSync(path.join(agentsDir(), id))) {
      return JSON.stringify({
        taskId: id,
        status: "error",
        costUsd: 0,
        error: `No agent task directory found for taskId: ${id}`,
      } as AgentTaskResult);
    }
  }

  const start = Date.now();
  const interval = Math.max(250, pollIntervalMs);
  // Message / abort checks run on a finer tick than the status poll so a
  // message is noticed quickly even with a long pollIntervalMs.
  const tick = Math.min(interval, 250);
  const missingProcessPolls: Record<string, number> = {};
  const statuses: Record<string, string> = {};
  let lastPoll = 0;

  while (true) {
    const now = Date.now();
    const pollDue = lastPoll === 0 || now - lastPoll >= interval;

    if (pollDue) {
      lastPoll = now;
      let firstMeta: any | null = null;
      let firstStatus = "unknown";
      let attention: { id: string; status: string } | undefined;

      for (const id of ids) {
        const meta = readMeta(id);
        const statusFile = readStatusFile(id);
        const status = resolveStatus(meta, statusFile);
        statuses[id] = status;
        if (id === ids[0]) {
          firstMeta = meta;
          firstStatus = status;
        }

        if (TERMINAL_STATUSES.has(status)) {
          return JSON.stringify(
            terminalResult(id, status, meta, start, multi ? { taskIds: ids } : {})
          );
        }

        // Liveness fallback: if metadata exposes a pid and it is no longer
        // alive, but no terminal status was written, treat the task as failed
        // after a couple of confirming polls (avoids a race where the process
        // just exited but hasn't flushed its final status yet).
        const pid = metaPid(meta);
        if (pid !== undefined && !pidAlive(pid)) {
          missingProcessPolls[id] = (missingProcessPolls[id] ?? 0) + 1;
          if (missingProcessPolls[id] >= 2) {
            return JSON.stringify(
              terminalResult(
                id,
                meta?.result ? "completed" : "failed",
                meta,
                start,
                {
                  ...(multi ? { taskIds: ids } : {}),
                  error: meta?.result
                    ? undefined
                    : "Agent process exited without writing a terminal status",
                }
              )
            );
          }
        } else {
          missingProcessPolls[id] = 0;
        }

        if (!attention && ATTENTION_STATUSES.has(status)) {
          attention = { id, status };
        }
      }

      // Messages for the caller take priority over child status changes.
      if (interruptOnMessages && (await callerHasPendingMessage(_ctx))) {
        return JSON.stringify(
          interruptedResult("pending_message", firstStatus, start, statuses, firstMeta)
        );
      }

      if (interruptOnChildStatus && attention) {
        return JSON.stringify({
          ...interruptedResult(
            "child_status",
            attention.status,
            start,
            statuses,
            readMeta(attention.id)
          ),
          taskId: attention.id,
        });
      }

      if (Date.now() - start >= timeoutMs) {
        return JSON.stringify({
          taskId,
          ...(multi ? { taskIds: ids } : {}),
          status: firstStatus,
          reason: "timeout",
          costUsd: firstMeta?.totalCostUsd ?? 0,
          finalAnswer: firstMeta?.result ?? lastAssistantText(firstMeta?.threads),
          artifacts: firstMeta?.artifacts,
          elapsedMs: Date.now() - start,
          timedOut: true,
        } as AgentTaskResult);
      }
    } else {
      if (interruptOnMessages && (await callerHasPendingMessage(_ctx))) {
        const firstMeta = readMeta(ids[0]);
        return JSON.stringify(
          interruptedResult(
            "pending_message",
            statuses[ids[0]] ?? "unknown",
            start,
            statuses,
            firstMeta
          )
        );
      }
    }

    if (signal?.aborted) {
      return JSON.stringify(
        interruptedResult(
          "user_interrupt",
          statuses[ids[0]] ?? "unknown",
          start,
          statuses,
          readMeta(ids[0])
        )
      );
    }

    await sleepOrAbort(tick, signal);
    if (signal?.aborted) {
      return JSON.stringify(
        interruptedResult(
          "user_interrupt",
          statuses[ids[0]] ?? "unknown",
          start,
          statuses,
          readMeta(ids[0])
        )
      );
    }
  }
}

/** Sleep that wakes immediately when the abort signal fires. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const waitForAgentCompletedDefinition: Tool = {
  type: "function",
  function: {
    name: "waitForAgentCompleted",
    description:
      "Block until a spawned agent task (started via startAgentTask or runGenerate) reaches a " +
      "terminal status (completed/failed/killed), then return a structured JSON result with " +
      "{ status, reason, costUsd, finalAnswer, artifacts, elapsedMs }. This is the native way to 'join' a " +
      "subagent — prefer it over shell polling loops with sleep. Returns immediately if the task is " +
      "already finished, and gives up with timedOut:true after timeoutMs. Also works for remote tasks " +
      "started with startAgentTask {worker} (polls the backend by UUID). " +
      "INTERRUPTIBLE: the wait returns early with { interrupted: true, reason, status } when (a) you " +
      "receive a message — a child's replyToParent / sendAgentMessage, a user message, a /poke or a " +
      "remote message (reason 'pending_message'; the message is NOT consumed, you will see it on your " +
      "next turn), (b) a child enters waiting/paused/needs-approval (reason 'child_status'), or (c) the " +
      "user interrupts the call (reason 'user_interrupt'). When the result has interrupted:true the child " +
      "is NOT finished: handle the message / child, then CALL waitForAgentCompleted AGAIN if you still " +
      "need the child's result. Pass taskIds to wait for the FIRST of several local children to finish " +
      "(result.taskId is the one that completed, reason 'completed'). Set interruptOnMessages:false to " +
      "wait uninterrupted by messages.",
    parameters: {
      type: "object",
      positional: false,
      usesContext: true,
      properties: {
        taskId: {
          type: "string",
          description:
            "The taskId of the agent task to wait for (as returned/used by startAgentTask).",
        },
        taskIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Wait for the FIRST of several local child tasks to complete. Can be used instead of, or together with, taskId. Local tasks only.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Maximum time to wait in milliseconds before returning with timedOut:true. Default: 1800000 (30 min).",
        },
        pollIntervalMs: {
          type: "number",
          description:
            "How often to poll the task status in milliseconds. Default: 2000.",
        },
        remote: {
          type: "boolean",
          description:
            "Force polling a remote (backend-synced) task by UUID, e.g. one started with startAgentTask {worker}. Auto-detected for UUID task ids with no local task dir.",
        },
        interruptOnMessages: {
          type: "boolean",
          description:
            "Return early (interrupted:true, reason 'pending_message') when you have an incoming message pending. Default: true.",
        },
        interruptOnChildStatus: {
          type: "boolean",
          description:
            "Return early (interrupted:true, reason 'child_status') when a child is waiting/paused/needs approval. Default: true.",
        },
      },
      required: [],
    },
  },
};
