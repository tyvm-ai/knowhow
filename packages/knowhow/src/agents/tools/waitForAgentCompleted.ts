import * as fs from "fs";
import * as path from "path";
import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";

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

interface AgentTaskResult {
  taskId: string;
  status: string;
  costUsd: number;
  finalAnswer?: string;
  artifacts?: string[];
  elapsedMs?: number;
  timedOut?: boolean;
  error?: string;
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
function lastAssistantText(threads: any): string | undefined {
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
 * Discover the pid of a spawned agent task. AgentSyncFs.createTask records the
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
  taskId: string;
  /** Max time to wait in milliseconds before returning timedOut. Default 30 min. */
  timeoutMs?: number;
  /** How often to poll status in milliseconds. Default 2000ms. */
  pollIntervalMs?: number;
  _ctx?: ToolCallContext;
}

/**
 * Block until a spawned agent task reaches a terminal status, then return a
 * structured result: { status, costUsd, finalAnswer, artifacts }.
 *
 * This is the native "join" primitive for orchestration — it must be a real
 * tool (not a script polling loop) because the script sandbox caps `sleep` and
 * burns a tool call per poll. It reads the consolidated status from
 * metadata.json / status.txt and falls back to a process-liveness check so a
 * crashed child doesn't hang the parent forever.
 */
export async function waitForAgentCompleted(
  params: WaitForAgentCompletedParams
): Promise<string> {
  const {
    taskId,
    timeoutMs = 30 * 60 * 1000,
    pollIntervalMs = 2000,
  } = params;

  if (!taskId) {
    return JSON.stringify({
      taskId,
      status: "error",
      costUsd: 0,
      error: "taskId is required for waitForAgentCompleted",
    } as AgentTaskResult);
  }

  const taskDir = path.join(agentsDir(), taskId);
  if (!fs.existsSync(taskDir)) {
    return JSON.stringify({
      taskId,
      status: "error",
      costUsd: 0,
      error: `No agent task directory found for taskId: ${taskId}`,
    } as AgentTaskResult);
  }

  const start = Date.now();
  const interval = Math.max(250, pollIntervalMs);
  let missingProcessPolls = 0;

  while (true) {
    const meta = readMeta(taskId);
    const statusFile = readStatusFile(taskId);
    const status = resolveStatus(meta, statusFile);

    if (TERMINAL_STATUSES.has(status)) {
      const finalAnswer =
        meta?.result ?? lastAssistantText(meta?.threads);
      const result: AgentTaskResult = {
        taskId,
        status,
        costUsd: meta?.totalCostUsd ?? 0,
        finalAnswer,
        artifacts: meta?.artifacts,
        elapsedMs: Date.now() - start,
      };
      return JSON.stringify(result);
    }

    // Liveness fallback: if metadata exposes a pid and it is no longer alive,
    // but no terminal status was written, treat the task as failed after a
    // couple of confirming polls (avoids a race where the process just exited
    // but hasn't flushed its final status yet).
    const pid = metaPid(meta);
    if (pid !== undefined && !pidAlive(pid)) {
      missingProcessPolls++;
      if (missingProcessPolls >= 2) {
        const finalAnswer =
          meta?.result ?? lastAssistantText(meta?.threads);
        return JSON.stringify({
          taskId,
          status: meta?.result ? "completed" : "failed",
          costUsd: meta?.totalCostUsd ?? 0,
          finalAnswer,
          artifacts: meta?.artifacts,
          elapsedMs: Date.now() - start,
          error: meta?.result
            ? undefined
            : "Agent process exited without writing a terminal status",
        } as AgentTaskResult);
      }
    } else {
      missingProcessPolls = 0;
    }

    if (Date.now() - start >= timeoutMs) {
      return JSON.stringify({
        taskId,
        status,
        costUsd: meta?.totalCostUsd ?? 0,
        finalAnswer: meta?.result ?? lastAssistantText(meta?.threads),
        artifacts: meta?.artifacts,
        elapsedMs: Date.now() - start,
        timedOut: true,
      } as AgentTaskResult);
    }

    await sleep(interval);
  }
}

export const waitForAgentCompletedDefinition: Tool = {
  type: "function",
  function: {
    name: "waitForAgentCompleted",
    description:
      "Block until a spawned agent task (started via startAgentTask or runGenerate) reaches a " +
      "terminal status (completed/failed/killed), then return a structured JSON result with " +
      "{ status, costUsd, finalAnswer, artifacts, elapsedMs }. This is the native way to 'join' a " +
      "subagent — prefer it over shell polling loops with sleep. Returns immediately if the task is " +
      "already finished, and gives up with timedOut:true after timeoutMs.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        taskId: {
          type: "string",
          description:
            "The taskId of the agent task to wait for (as returned/used by startAgentTask).",
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
      },
      required: ["taskId"],
    },
  },
};
