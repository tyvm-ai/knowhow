/**
 * Script-sandbox helpers for working with remote workers / cloud sandboxes.
 *
 * This is plain JS source evaluated INSIDE the isolate (after callTool and the
 * generic tool globals exist), so it only relies on `callTool`. It defines:
 *
 *   workers.list(opts?)                       -> WorkerSummary[]          (listWorkers)
 *   workers.exec(worker, command, timeoutMs?) -> { worker, stdout, stderr, exitCode } (workerExec)
 *   workers.snapshots(cloudWorker)            -> SnapshotChoice[]         (listCloudWorkerSnapshots)
 *   workers.startCloud(cloudWorker, opts?)    -> { cloudWorkerId, workerId, name }  (startCloudWorker, COSTS MONEY)
 *   workers.fork(snapshotId, opts?)           -> { sandboxId, cloudWorkerId, workerId, name } (forkCloudWorker, COSTS MONEY)
 *   workers.stopCloud(cloudWorker, opts?)     -> { stopped }              (stopCloudWorker)
 *   workers.destroy(sandboxId)                -> { destroyed }            (destroyForkedSandbox)
 *   remoteAgent({ worker, prompt, ... })      -> { taskId, status, finalAnswer, workerName }
 *
 * Tool results may be JSON strings (CLI tools) or already-parsed objects;
 * `{ error }` results are thrown as Errors.
 */
export const WORKER_HELPERS_JS = `
(function () {
  function parse(name, r) {
    if (r && typeof r === "object" && "functionResp" in r) r = r.functionResp;
    if (typeof r === "string") {
      try { r = JSON.parse(r); } catch (e) { /* leave as string */ }
    }
    if (r && typeof r === "object" && !Array.isArray(r) && typeof r.error === "string" && r.error) {
      throw new Error(name + ": " + r.error);
    }
    return r;
  }
  async function call(name, args) {
    return parse(name, await callTool(name, args || {}));
  }
  globalThis.workers = {
    list: (opts) => call("listWorkers", opts),
    exec: (worker, command, timeoutMs) =>
      call("workerExec", { worker, command, timeoutMs }),
    snapshots: (cloudWorker) =>
      call("listCloudWorkerSnapshots", { cloudWorker }),
    startCloud: (cloudWorker, opts) =>
      call("startCloudWorker", Object.assign({}, opts || {}, { cloudWorker })),
    fork: (snapshotId, opts) =>
      call("forkCloudWorker", Object.assign({}, opts || {}, { snapshotId })),
    stopCloud: (cloudWorker, opts) =>
      call("stopCloudWorker", Object.assign({}, opts || {}, { cloudWorker })),
    destroy: (sandboxId) => call("destroyForkedSandbox", { sandboxId }),
  };
  globalThis.remoteAgent = async function (opts) {
    if (!opts || !opts.worker) throw new Error("remoteAgent: worker is required");
    if (!opts.prompt) throw new Error("remoteAgent: prompt is required");
    const args = Object.assign({}, opts, { waitForCompletion: opts.waitForCompletion !== false });
    const r = await call("startAgentTask", args);
    return {
      taskId: r && (r.remoteTaskId || r.taskId),
      status: r && r.status,
      success: r && r.success,
      finalAnswer: r && r.finalAnswer,
      workerName: r && r.workerName,
      error: r && r.error,
    };
  };
})();
`;

/** Declarations appended to the generated script typeDefs. */
export const WORKER_HELPERS_TYPEDEFS: string[] = [
  "declare interface SnapshotChoice { id: string; name?: string; createdAt?: string; status?: string; sizeBytes?: number; isDefault?: boolean; sandboxId?: string }",
  "declare interface WorkerExecResult { worker: string; stdout: string; stderr: string; exitCode: number | null }",
  "declare interface RemoteAgentResult { taskId: string; status: string; success?: boolean; finalAnswer?: string; workerName?: string; error?: string }",
  "/** Remote worker / cloud sandbox helpers (thin wrappers over callTool; errors throw). startCloud/fork/stopCloud/destroy touch billable sandboxes — always clean up in a finally. */",
  "declare const workers: {",
  "  /** List connected workers (listWorkers). */",
  "  list(opts?: { onlyConnected?: boolean; includeClients?: boolean; os?: 'windows' | 'posix'; nameContains?: string }): Promise<any[]>;",
  "  /** Run a short shell command on a worker (workerExec, ~25s limit). */",
  "  exec(worker: string, command: string, timeoutMs?: number): Promise<WorkerExecResult>;",
  "  /** Ready snapshots of a cloud worker, newest first (listCloudWorkerSnapshots). */",
  "  snapshots(cloudWorker: string): Promise<SnapshotChoice[]>;",
  "  /** COST: start a stopped cloud worker (startCloudWorker). opts.snapshotId resumes a snapshot, opts.fresh = cold start. */",
  "  startCloud(cloudWorker: string, opts?: { snapshotId?: string; fresh?: boolean; waitForConnect?: boolean; timeoutMs?: number }): Promise<{ cloudWorkerId: string; workerId?: string; name: string }>;",
  "  /** COST: fork a NEW sandbox from a snapshot (forkCloudWorker). Destroy it with workers.destroy. */",
  "  fork(snapshotId: string, opts?: { name?: string; waitForConnect?: boolean; timeoutMs?: number }): Promise<{ sandboxId: string; cloudWorkerId?: string; workerId?: string; name: string }>;",
  "  /** Stop a cloud worker (stopCloudWorker). */",
  "  stopCloud(cloudWorker: string, opts?: { snapshot?: boolean }): Promise<{ stopped: boolean }>;",
  "  /** Destroy a forked sandbox (destroyForkedSandbox). */",
  "  destroy(sandboxId: string): Promise<{ destroyed: boolean }>;",
  "};",
  "/** Run a full agent ON a remote worker and wait for it: startAgentTask {worker, waitForCompletion} -> { taskId, finalAnswer }. */",
  "declare function remoteAgent(opts: { worker: string; prompt: string; agentName?: string; model?: string; provider?: string; maxTimeLimit?: number; maxSpendLimit?: number; waitForCompletion?: boolean }): Promise<RemoteAgentResult>;",
];
