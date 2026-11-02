import { Tool } from "../../clients/types";
import {
  listSnapshotsForCloudWorker,
  startCloudWorker as launcherStartCloudWorker,
  forkFromSnapshot,
  stopCloudWorker as launcherStopCloudWorker,
  destroyForkedSandbox as launcherDestroyForkedSandbox,
} from "../../services/WorkerLauncher";

/**
 * Thin tool wrappers over services/WorkerLauncher.ts.
 * All tools return a JSON string: the result object, or {"error": "..."}.
 * NOTE: startCloudWorker / forkCloudWorker / stopCloudWorker / destroyForkedSandbox
 * touch billable sandboxes. Always clean up what you create.
 */

function errJson(e: any): string {
  return JSON.stringify({ error: e?.message ?? String(e) });
}

/**
 * Map tool params to the launcher's snapshotId option:
 * fresh=true -> false (clean cold start), string -> that snapshot, else undefined (auto-resume).
 */
export function resolveSnapshotOption(params: {
  snapshotId?: string;
  fresh?: boolean;
}): string | false | undefined {
  if (params.fresh) {
    if (params.snapshotId) {
      throw new Error("Pass either snapshotId or fresh=true, not both");
    }
    return false;
  }
  return params.snapshotId || undefined;
}

// ───────────────────────── listCloudWorkerSnapshots ─────────────────────────

export interface ListCloudWorkerSnapshotsParams {
  cloudWorker: string;
}

export async function listCloudWorkerSnapshots(
  params: ListCloudWorkerSnapshotsParams
): Promise<string> {
  try {
    if (!params.cloudWorker) throw new Error("cloudWorker is required");
    const snaps = await listSnapshotsForCloudWorker(params.cloudWorker);
    return JSON.stringify(snaps);
  } catch (e) {
    return errJson(e);
  }
}

export const listCloudWorkerSnapshotsDefinition: Tool = {
  type: "function",
  function: {
    name: "listCloudWorkerSnapshots",
    description:
      "List the ready disk/memory snapshots of a cloud worker (sandbox), newest first: id, name, createdAt, sizeBytes, isDefault (isDefault = the one a plain start would resume from). Use a snapshot id with startCloudWorker or forkCloudWorker. Free / read-only.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        cloudWorker: {
          type: "string",
          description: "Cloud worker id or name (e.g. \"Knowhow-web\").",
        },
      },
      required: ["cloudWorker"],
    },
  },
};

// ───────────────────────────── startCloudWorker ─────────────────────────────

export interface StartCloudWorkerParams {
  cloudWorker: string;
  snapshotId?: string;
  fresh?: boolean;
  /** default true */
  waitForConnect?: boolean;
  timeoutMs?: number;
}

export async function startCloudWorker(
  params: StartCloudWorkerParams
): Promise<string> {
  try {
    if (!params.cloudWorker) throw new Error("cloudWorker is required");
    const snapshotId = resolveSnapshotOption(params);
    const r = await launcherStartCloudWorker(params.cloudWorker, {
      snapshotId,
      waitForConnect: params.waitForConnect ?? true,
      timeoutMs: params.timeoutMs,
    });
    return JSON.stringify(r);
  } catch (e) {
    return errJson(e);
  }
}

export const startCloudWorkerDefinition: Tool = {
  type: "function",
  function: {
    name: "startCloudWorker",
    description:
      "COST-INCURRING: start a stopped cloud worker (sandbox VM) and, by default, wait until its worker connects. Default resumes from the last snapshot; pass snapshotId to resume from a specific one, or fresh=true for a clean cold start. No-op if already running. Returns {cloudWorkerId, workerId, name}; use workerId with workerExec / startAgentTask {worker}. Stop it with stopCloudWorker when done.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        cloudWorker: {
          type: "string",
          description: "Cloud worker id or name.",
        },
        snapshotId: {
          type: "string",
          description:
            "Resume from this snapshot id (see listCloudWorkerSnapshots). Default: the worker's last snapshot.",
        },
        fresh: {
          type: "boolean",
          description: "Clean cold start with no snapshot. Mutually exclusive with snapshotId.",
        },
        waitForConnect: {
          type: "boolean",
          description: "Wait until the worker is connected. Default true.",
        },
        timeoutMs: {
          type: "number",
          description: "Max wait for connect in ms. Default 6 minutes.",
        },
      },
      required: ["cloudWorker"],
    },
  },
};

// ───────────────────────────── forkCloudWorker ──────────────────────────────

export interface ForkCloudWorkerParams {
  snapshotId: string;
  name?: string;
  /** default true */
  waitForConnect?: boolean;
  timeoutMs?: number;
}

export async function forkCloudWorker(
  params: ForkCloudWorkerParams
): Promise<string> {
  try {
    if (!params.snapshotId) throw new Error("snapshotId is required");
    const r = await forkFromSnapshot({
      snapshotId: params.snapshotId,
      name: params.name,
      waitForConnect: params.waitForConnect ?? true,
      timeoutMs: params.timeoutMs,
    });
    return JSON.stringify(r);
  } catch (e) {
    return errJson(e);
  }
}

export const forkCloudWorkerDefinition: Tool = {
  type: "function",
  function: {
    name: "forkCloudWorker",
    description:
      "COST-INCURRING: create a NEW sandbox from a ready snapshot (the original cloud worker is untouched), start it, and by default wait until its worker connects. Returns {sandboxId, cloudWorkerId, workerId, name}. Use workerId with workerExec / startAgentTask {worker}. You MUST call destroyForkedSandbox {sandboxId} when finished.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        snapshotId: {
          type: "string",
          description: "Snapshot id to fork from (see listCloudWorkerSnapshots).",
        },
        name: {
          type: "string",
          description: "Optional name for the new sandbox.",
        },
        waitForConnect: {
          type: "boolean",
          description: "Wait until the forked worker is connected. Default true.",
        },
        timeoutMs: {
          type: "number",
          description: "Max wait for connect in ms. Default 6 minutes.",
        },
      },
      required: ["snapshotId"],
    },
  },
};

// ────────────────────────────── stopCloudWorker ─────────────────────────────

export interface StopCloudWorkerParams {
  cloudWorker: string;
  snapshot?: boolean;
}

export async function stopCloudWorker(
  params: StopCloudWorkerParams
): Promise<string> {
  try {
    if (!params.cloudWorker) throw new Error("cloudWorker is required");
    await launcherStopCloudWorker(params.cloudWorker, {
      snapshot: params.snapshot,
    });
    return JSON.stringify({ stopped: true, cloudWorker: params.cloudWorker });
  } catch (e) {
    return errJson(e);
  }
}

export const stopCloudWorkerDefinition: Tool = {
  type: "function",
  function: {
    name: "stopCloudWorker",
    description:
      "COST-INCURRING (stops billing, but snapshot=true stores a new snapshot): stop a running cloud worker. snapshot=true saves a snapshot first so the next start resumes from it; default false discards the running state.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        cloudWorker: {
          type: "string",
          description: "Cloud worker id or name.",
        },
        snapshot: {
          type: "boolean",
          description: "Take a snapshot before stopping. Default false.",
        },
      },
      required: ["cloudWorker"],
    },
  },
};

// ───────────────────────────── destroyForkedSandbox ─────────────────────────

export interface DestroyForkedSandboxParams {
  sandboxId: string;
}

export async function destroyForkedSandbox(
  params: DestroyForkedSandboxParams
): Promise<string> {
  try {
    if (!params.sandboxId) throw new Error("sandboxId is required");
    await launcherDestroyForkedSandbox(params.sandboxId);
    return JSON.stringify({ destroyed: true, sandboxId: params.sandboxId });
  } catch (e) {
    return errJson(e);
  }
}

export const destroyForkedSandboxDefinition: Tool = {
  type: "function",
  function: {
    name: "destroyForkedSandbox",
    description:
      "DESTRUCTIVE / COST-RELATED: permanently destroy a sandbox (typically one created by forkCloudWorker) so it stops costing money. Its unsnapshotted state is lost. Only call with sandboxIds you created.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        sandboxId: {
          type: "string",
          description: "Sandbox id returned by forkCloudWorker.",
        },
      },
      required: ["sandboxId"],
    },
  },
};
