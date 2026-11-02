import { Tool } from "../../clients/types";
import {
  CheckoutInput,
  checkoutResolved,
  sandboxIdForCloudWorker,
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

const checkoutSpecProperties = {
  taskId: {
    type: "string",
    description:
      "Mode A: backend task UUID, or \"current\" / a local task id (resolved to the backend UUID). Checks out the task workspace (HEAD = base commit, worktree = latest snapshot incl. WIP).",
  },
  pushSnapshot: {
    type: "boolean",
    description:
      "Mode A: push a fresh workspace snapshot of the local cwd first so the sandbox gets the current WIP.",
  },
  workspaceSnapshotId: {
    type: "string",
    description: "Mode A: specific task workspace snapshot id (default: latest).",
  },
  repositoryId: {
    type: "string",
    description:
      "Mode B: GitRepository id. Omit to resolve it from the local cwd git repo when commitSha/branch is given (base bundles are uploaded automatically).",
  },
  commitSha: { type: "string", description: "Mode B: full 40/64-char commit sha." },
  branch: { type: "string", description: "Mode B: branch name to check out." },
  newBranch: { type: "string", description: "Local branch to create in the sandbox." },
  installDeps: {
    type: "boolean",
    description: "Run a background npm ci after checkout. Default false.",
  },
  registerTask: {
    type: "boolean",
    description:
      "Mode A: register the task dir so `knowhow agents resume <taskId>` works in the sandbox. Default true.",
  },
};

const CHECKOUT_RESULT_NOTE =
  "checkout = {checkoutId, sandboxId, repoDir, cwd, commitSha, branch, verified}; run agents/commands in `cwd`.";

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
  /** After connect, check out a task/commit in the sandbox (see checkoutCloudWorker). Requires waitForConnect. */
  checkout?: CheckoutInput;
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
      checkout: params.checkout,
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
      "COST-INCURRING: start a stopped cloud worker (sandbox VM) and, by default, wait until its worker connects. Default resumes from the last snapshot; pass snapshotId to resume from a specific one, or fresh=true for a clean cold start. No-op if already running. Returns {cloudWorkerId, workerId, name, sandboxId?, checkout?}; use workerId with workerExec / startAgentTask {worker}. Pass `checkout` to also materialize a task/commit in the sandbox once connected (result.checkout; see checkoutCloudWorker). Stop it with stopCloudWorker when done.",
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
        checkout: {
          type: "object",
          description:
            "Optional: after the worker connects, run a checkout in its sandbox. Same fields as checkoutCloudWorker (taskId|repositoryId, commitSha, branch, newBranch, installDeps, registerTask, pushSnapshot, workspaceSnapshotId).",
          properties: checkoutSpecProperties,
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
  /** integer >= 1. Only honoured for disk checkpoints. */
  cpuCount?: number;
  /** integer >= 256. Only honoured for disk checkpoints. */
  memoryMb?: number;
  /** integer >= 1, can only grow vs the snapshot disk. Only honoured for disk checkpoints. */
  diskGb?: number;
  /** default true */
  waitForConnect?: boolean;
  timeoutMs?: number;
  /** After connect, check out a task/commit in the sandbox (see checkoutCloudWorker). Requires waitForConnect. */
  checkout?: CheckoutInput;
}

export async function forkCloudWorker(
  params: ForkCloudWorkerParams
): Promise<string> {
  try {
    if (!params.snapshotId) throw new Error("snapshotId is required");
    const r = await forkFromSnapshot({
      snapshotId: params.snapshotId,
      name: params.name,
      cpuCount: params.cpuCount,
      memoryMb: params.memoryMb,
      diskGb: params.diskGb,
      waitForConnect: params.waitForConnect ?? true,
      timeoutMs: params.timeoutMs,
      checkout: params.checkout,
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
      "COST-INCURRING: create a NEW sandbox from a ready snapshot (the original cloud worker is untouched), start it, and by default wait until its worker connects. Optionally resize the fork with cpuCount / memoryMb / diskGb — resizing ONLY works when forking a DISK checkpoint (disk_only snapshot); memory snapshots restore with their original vCPU/RAM and a different value is rejected with an error. Pass `checkout` to also materialize a task/commit in the sandbox once connected. Returns {sandboxId, cloudWorkerId, workerId, name, cpuCount?, memoryMb?, diskGb?, checkout?}. Use workerId with workerExec / startAgentTask {worker}. You MUST call destroyForkedSandbox {sandboxId} when finished.",
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
        cpuCount: {
          type: "number",
          description:
            "vCPUs for the fork (integer >= 1). Only works for disk checkpoints, not memory snapshots.",
        },
        memoryMb: {
          type: "number",
          description:
            "RAM in MB for the fork (integer >= 256, e.g. 4096). Only works for disk checkpoints, not memory snapshots.",
        },
        diskGb: {
          type: "number",
          description:
            "Disk size in GB (integer >= 1; can only grow vs the snapshot). Only works for disk checkpoints, not memory snapshots.",
        },
        waitForConnect: {
          type: "boolean",
          description: "Wait until the forked worker is connected. Default true.",
        },
        timeoutMs: {
          type: "number",
          description: "Max wait for connect in ms. Default 6 minutes.",
        },
        checkout: {
          type: "object",
          description:
            "Optional: after the worker connects, run a checkout in the new sandbox. Same fields as checkoutCloudWorker (taskId|repositoryId, commitSha, branch, newBranch, installDeps, registerTask, pushSnapshot, workspaceSnapshotId). " +
            CHECKOUT_RESULT_NOTE,
          properties: checkoutSpecProperties,
        },
      },
      required: ["snapshotId"],
    },
  },
};

// ──────────────────────────── checkoutCloudWorker ───────────────────────────

export interface CheckoutCloudWorkerParams extends CheckoutInput {
  /** Cloud worker id or name (its current sandbox is used). Either this or sandboxId. */
  cloudWorker?: string;
  /** Sandbox id (e.g. from forkCloudWorker). Either this or cloudWorker. */
  sandboxId?: string;
  timeoutMs?: number;
}

export async function checkoutCloudWorker(
  params: CheckoutCloudWorkerParams
): Promise<string> {
  try {
    if (!params.sandboxId && !params.cloudWorker) {
      throw new Error("Provide cloudWorker (id/name) or sandboxId");
    }
    if (params.sandboxId && params.cloudWorker) {
      throw new Error("Pass either cloudWorker or sandboxId, not both");
    }
    const { cloudWorker, sandboxId, timeoutMs, ...spec } = params;
    const target = sandboxId || (await sandboxIdForCloudWorker(cloudWorker as string));
    const r = await checkoutResolved(target, spec, { timeoutMs });
    return JSON.stringify(r);
  } catch (e) {
    return errJson(e);
  }
}

export const checkoutCloudWorkerDefinition: Tool = {
  type: "function",
  function: {
    name: "checkoutCloudWorker",
    description:
      "Materialize a git tree inside a RUNNING sandbox and wait until it is ready. Mode A (taskId): the task workspace, same as /offload prep (HEAD = base commit, worktree = latest snapshot incl. WIP); taskId may be \"current\" or a local task id, and pushSnapshot=true uploads a fresh snapshot of the local cwd first. Mode B (repositoryId/commitSha/branch): a plain commit or branch; if only commitSha/branch is given, the repository is resolved from the local cwd git repo and its base bundles are uploaded so the sandbox can fetch the commit. Target the sandbox with cloudWorker (id/name) or sandboxId (e.g. from forkCloudWorker). Returns {checkoutId, sandboxId, repoDir, cwd, commitSha, branch, verified}; run agents/commands in `cwd`. Throws (with the error and log tail) if the checkout fails.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        cloudWorker: {
          type: "string",
          description: "Cloud worker id or name (uses its current sandbox). Either this or sandboxId.",
        },
        sandboxId: {
          type: "string",
          description: "Sandbox id (e.g. returned by forkCloudWorker). Either this or cloudWorker.",
        },
        ...checkoutSpecProperties,
        timeoutMs: {
          type: "number",
          description: "Max wait for the checkout in ms. Default 10 minutes.",
        },
      },
      required: [],
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
