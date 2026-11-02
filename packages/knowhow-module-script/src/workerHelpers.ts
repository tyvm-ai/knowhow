/**
 * Script-sandbox helpers for working with remote workers / cloud sandboxes.
 *
 * This is plain JS source evaluated INSIDE the isolate (after callTool and the
 * generic tool globals exist), so it only relies on `callTool`. It defines:
 *
 *   workers.list(opts?)                       -> WorkerSummary[]          (listWorkers)
 *   workers.exec(worker, command, timeoutMs?) -> { worker, stdout, stderr?, exitCode? } (workerExec)
 *   workers.snapshots(cloudWorker)            -> SnapshotChoice[]         (listCloudWorkerSnapshots)
 *   workers.startCloud(cloudWorker, opts?)    -> { cloudWorkerId, workerId?, name, sandboxId?, checkout? } (startCloudWorker, COSTS MONEY)
 *   workers.fork(snapshotId, opts?)           -> { sandboxId, cloudWorkerId?, workerId?, name, cpuCount?, memoryMb?, diskGb?, checkout? } (forkCloudWorker, COSTS MONEY)
 *   workers.checkout(target, spec)            -> { checkoutId, sandboxId, repoDir?, cwd?, commitSha?, branch?, verified? } (checkoutCloudWorker)
 *   workers.stopCloud(cloudWorker, opts?)     -> { stopped, cloudWorker } (stopCloudWorker)
 *   workers.destroy(sandboxId)                -> { destroyed, sandboxId } (destroyForkedSandbox)
 *   remoteAgent({ worker, prompt, cwd?, ... })-> { taskId, status, success, finalAnswer, workerName, error }
 *
 * Tool results may be JSON strings (CLI tools) or already-parsed objects;
 * `{ error }` results are thrown as Errors (except remoteAgent, where a failed
 * agent resolves with status "failed" and `error` set).
 */
export const WORKER_HELPERS_JS = `
(function () {
  function unwrapResp(r) {
    if (r && typeof r === "object" && "functionResp" in r) r = r.functionResp;
    if (typeof r === "string") {
      try { r = JSON.parse(r); } catch (e) { /* leave as string */ }
    }
    return r;
  }
  function parse(name, r) {
    r = unwrapResp(r);
    if (r && typeof r === "object" && !Array.isArray(r) && typeof r.error === "string" && r.error) {
      throw new Error(name + ": " + r.error);
    }
    return r;
  }
  async function call(name, args) {
    return parse(name, await callTool(name, args || {}));
  }
  // Resolve a checkout target: a launch result ({ sandboxId } / { cloudWorkerId }),
  // { sandboxId } / { cloudWorker }, or a string = cloud worker id/name.
  function checkoutTarget(target) {
    if (typeof target === "string") return { cloudWorker: target };
    if (target && typeof target === "object") {
      if (target.sandboxId) return { sandboxId: target.sandboxId };
      if (target.cloudWorker) return { cloudWorker: target.cloudWorker };
      if (target.cloudWorkerId) return { cloudWorker: target.cloudWorkerId };
    }
    throw new Error("workers.checkout: target must be a cloud worker id/name, { sandboxId }, { cloudWorker } or a workers.fork/startCloud result");
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
    checkout: async (target, spec) =>
      call("checkoutCloudWorker", Object.assign({}, spec || {}, checkoutTarget(target))),
    stopCloud: (cloudWorker, opts) =>
      call("stopCloudWorker", Object.assign({}, opts || {}, { cloudWorker })),
    destroy: (sandboxId) => call("destroyForkedSandbox", { sandboxId }),
  };
  globalThis.remoteAgent = async function (opts) {
    if (!opts || !opts.worker) throw new Error("remoteAgent: worker is required");
    if (!opts.prompt) throw new Error("remoteAgent: prompt is required");
    const args = Object.assign({}, opts, { waitForCompletion: opts.waitForCompletion !== false });
    // startAgentTask has no working-dir parameter, so cwd (e.g. workers.checkout(...).cwd)
    // is passed to the remote agent as an instruction in the prompt.
    if (args.cwd) {
      args.prompt =
        "Your working directory for this task is " + args.cwd +
        ". cd there first and run all commands / edit files there.\\n\\n" + args.prompt;
    }
    delete args.cwd;
    const r = unwrapResp(await callTool("startAgentTask", args));
    // A failed remote agent resolves with status "failed" + error; only a result
    // with neither a taskId nor a status is a hard error.
    if (r && typeof r === "object" && typeof r.error === "string" && r.error && !(r.remoteTaskId || r.taskId || r.status)) {
      throw new Error("startAgentTask: " + r.error);
    }
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

/** Declarations appended to the generated script typeDefs. Must match the tool return shapes. */
export const WORKER_HELPERS_TYPEDEFS: string[] = [
  "declare interface SnapshotChoice { id: string; name?: string; createdAt?: string; status?: string; sizeBytes?: number; isDefault?: boolean; sandboxId?: string }",
  "declare interface WorkerSummary { id: string; name: string; os: 'windows' | 'posix' | 'unknown'; root: string; platform?: string; arch?: string; connected: boolean; status: 'online' | 'offline'; shared: boolean; owner?: string; cloudWorkerId: string | null; lastConnected: string; clientKind?: string | null }",
  "declare interface WorkerExecResult { worker: string; stdout: string; stderr?: string; exitCode?: number }",
  "/** Result of a sandbox checkout. Run agents/commands in `cwd`. */",
  "declare interface CheckoutResult { checkoutId: string; sandboxId: string; repoDir?: string; cwd?: string; commitSha?: string; branch?: string; verified?: boolean | null }",
  "/** Checkout spec: mode A = taskId (\"current\" / local task id / backend UUID), mode B = repositoryId and/or commitSha/branch (repositoryId is resolved from the local cwd git repo when omitted). */",
  "declare interface CheckoutSpec { taskId?: string; pushSnapshot?: boolean; workspaceSnapshotId?: string; repositoryId?: string; commitSha?: string; branch?: string; newBranch?: string; installDeps?: boolean; registerTask?: boolean }",
  "declare interface StartCloudResult { cloudWorkerId: string; workerId?: string; name: string; sandboxId?: string; checkout?: CheckoutResult }",
  "declare interface ForkResult { sandboxId: string; cloudWorkerId?: string; workerId?: string; name: string; cpuCount?: number; memoryMb?: number; diskGb?: number; checkout?: CheckoutResult }",
  "declare interface RemoteAgentResult { taskId: string; status: 'started' | 'completed' | 'failed'; success?: boolean; finalAnswer?: string; workerName?: string; error?: string }",
  "/** Remote worker / cloud sandbox helpers (thin wrappers over callTool; `{error}` results throw). startCloud/fork/stopCloud/destroy touch billable sandboxes — always clean up in a finally. */",
  "declare const workers: {",
  "  /** List connected workers (listWorkers). */",
  "  list(opts?: { onlyConnected?: boolean; includeClients?: boolean; os?: 'windows' | 'posix'; nameContains?: string }): Promise<WorkerSummary[]>;",
  "  /** Run a short shell command on a worker (workerExec, ~25s limit). */",
  "  exec(worker: string, command: string, timeoutMs?: number): Promise<WorkerExecResult>;",
  "  /** Ready snapshots of a cloud worker, newest first (listCloudWorkerSnapshots). */",
  "  snapshots(cloudWorker: string): Promise<SnapshotChoice[]>;",
  "  /** COST: start a stopped cloud worker (startCloudWorker). opts.snapshotId resumes a snapshot, opts.fresh = cold start, opts.checkout = check out a task/commit once connected (result.checkout). */",
  "  startCloud(cloudWorker: string, opts?: { snapshotId?: string; fresh?: boolean; waitForConnect?: boolean; timeoutMs?: number; checkout?: CheckoutSpec }): Promise<StartCloudResult>;",
  "  /** COST: fork a NEW sandbox from a snapshot (forkCloudWorker). cpuCount/memoryMb/diskGb resize it but ONLY work for disk checkpoints, not memory snapshots. opts.checkout checks out a task/commit once connected (result.checkout). Destroy it with workers.destroy. */",
  "  fork(snapshotId: string, opts?: { name?: string; cpuCount?: number; memoryMb?: number; diskGb?: number; waitForConnect?: boolean; timeoutMs?: number; checkout?: CheckoutSpec }): Promise<ForkResult>;",
  "  /** Materialize a git tree in a running sandbox and wait for it (checkoutCloudWorker). target: a workers.fork/startCloud result, { sandboxId }, { cloudWorker }, or a cloud worker id/name string. */",
  "  checkout(target: string | { sandboxId?: string; cloudWorker?: string; cloudWorkerId?: string }, spec: CheckoutSpec & { timeoutMs?: number }): Promise<CheckoutResult>;",
  "  /** Stop a cloud worker (stopCloudWorker). */",
  "  stopCloud(cloudWorker: string, opts?: { snapshot?: boolean }): Promise<{ stopped: boolean; cloudWorker: string }>;",
  "  /** Destroy a forked sandbox (destroyForkedSandbox). */",
  "  destroy(sandboxId: string): Promise<{ destroyed: boolean; sandboxId: string }>;",
  "};",
  "/** Run a full agent ON a remote worker and wait for it: startAgentTask {worker, waitForCompletion} -> { taskId, status, finalAnswer }. A failed agent resolves with status 'failed' + error. `cwd` (e.g. from workers.checkout) is passed to the agent as an instruction to work in that directory. */",
  "declare function remoteAgent(opts: { worker: string; prompt: string; cwd?: string; agentName?: string; model?: string; provider?: string; maxTimeLimit?: number; maxSpendLimit?: number; waitForCompletion?: boolean }): Promise<RemoteAgentResult>;",
];
