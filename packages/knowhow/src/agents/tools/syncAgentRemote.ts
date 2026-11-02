import * as fs from "fs";
import * as path from "path";
import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";
import { appendInput } from "../../services/stateful/channels/inputStream";
import {
  localAgentsDir,
  readLocalRemoteTaskId,
  waitForLocalRemoteTaskId,
} from "../../services/RemoteTaskLink";

export interface SyncAgentRemoteParams {
  /** Local taskId to sync (default: the calling agent's own task). */
  taskId?: string;
  /** Attach to this existing remote task UUID instead of creating one. */
  remoteTaskId?: string;
  /** Run the sync on this remote worker (id, prefix, name). `taskId` is then the worker's local taskId. */
  worker?: string;
  /** Max time to wait for the link to appear in metadata.json (default 15000ms). */
  timeoutMs?: number;
  _ctx?: ToolCallContext;
}

export interface SyncAgentRemoteResult {
  success: boolean;
  taskId?: string;
  remoteTaskId?: string;
  alreadyLinked?: boolean;
  workerId?: string;
  error?: string;
}

/**
 * Ask a LOCAL running agent to attach its remote (web) channel: appends
 * `/sync:remote [uuid]` to its input.txt (handled by AgentSession.onInput) and
 * polls its metadata.json until `remoteTaskId` shows up.
 */
export async function syncLocalAgentRemote(
  taskId: string,
  remoteTaskId?: string,
  opts: { timeoutMs?: number; baseDir?: string; pollMs?: number } = {}
): Promise<SyncAgentRemoteResult> {
  const baseDir = opts.baseDir ?? localAgentsDir();
  const dir = path.join(baseDir, taskId);
  if (!fs.existsSync(dir)) {
    return {
      success: false,
      taskId,
      error: `task directory not found: ${dir}`,
    };
  }
  const existing = readLocalRemoteTaskId(taskId, baseDir);
  if (existing && (!remoteTaskId || remoteTaskId === existing)) {
    return { success: true, taskId, remoteTaskId: existing, alreadyLinked: true };
  }
  appendInput(path.join(dir, "input.txt"), {
    text: remoteTaskId ? `/sync:remote ${remoteTaskId}` : "/sync:remote",
  });
  const linked = await waitForLocalRemoteTaskId(taskId, {
    timeoutMs: opts.timeoutMs ?? 15_000,
    pollMs: opts.pollMs,
    baseDir,
  });
  if (!linked) {
    return {
      success: false,
      taskId,
      error:
        "timed out waiting for the agent to link a remote task (is the agent still running?)",
    };
  }
  return { success: true, taskId, remoteTaskId: linked };
}

/**
 * Sync any agent (this one by default, another local one, or one on a worker)
 * to the knowhow backend at any point in its run, so it shows up in the web UI
 * with its full thread history and can receive messages from it.
 */
export async function syncAgentRemote(
  params: SyncAgentRemoteParams = {}
): Promise<SyncAgentRemoteResult> {
  const { worker, remoteTaskId, _ctx, timeoutMs } = params;
  const taskId =
    params.taskId ?? _ctx?.taskId ?? (_ctx?.caller as any)?.currentTaskId;

  if (worker) {
    if (!taskId) {
      return { success: false, error: "taskId is required together with worker" };
    }
    try {
      const remote = await import("../../services/RemoteWorkers");
      const { KnowhowSimpleClient } = await import("../../services/KnowhowClient");
      const client = new KnowhowSimpleClient();
      const w = await remote.resolveWorker(worker, client);
      const res = await remote.callWorkerTool(client, w.id, "syncAgentRemote", {
        taskId,
        remoteTaskId,
        timeoutMs,
      });
      if (res && typeof res === "object") {
        return { ...res, workerId: w.id };
      }
      return { success: false, workerId: w.id, error: String(res) };
    } catch (e: any) {
      return { success: false, taskId, error: e?.message ?? String(e) };
    }
  }

  if (!taskId) {
    return {
      success: false,
      error: "taskId is required (no calling task found in context)",
    };
  }
  const remoteMod = await import("../../services/RemoteWorkers");
  const cleanRemote = remoteTaskId
    ? remoteMod.stripRemotePrefix(remoteTaskId)
    : undefined;
  return syncLocalAgentRemote(taskId, cleanRemote, { timeoutMs });
}

export const syncAgentRemoteDefinition: Tool = {
  type: "function",
  function: {
    name: "syncAgentRemote",
    description:
      "Sync an agent to the knowhow backend (web UI) at any point in its run. Defaults to your OWN task. " +
      "Creates a remote task (or attaches to the given remoteTaskId), pushes the full thread history and keeps " +
      "syncing; messages sent from the web arrive as input. Returns { taskId, remoteTaskId }. " +
      "Pass `taskId` to sync another local agent, or `worker` (+ the worker's local taskId) to do it on another machine. " +
      "Needed e.g. before spawning remote children that must replyToParent.",
    parameters: {
      type: "object",
      positional: false,
      usesContext: true,
      properties: {
        taskId: {
          type: "string",
          description:
            "Local taskId of the agent to sync (default: the calling agent's own task).",
        },
        remoteTaskId: {
          type: "string",
          description:
            "Existing remote task UUID to attach to. If omitted a new remote task is created.",
        },
        worker: {
          type: "string",
          description:
            "Run the sync on this remote worker (id, id-prefix, name). taskId is then the task id on that worker.",
        },
      },
      required: [],
    },
  },
};
