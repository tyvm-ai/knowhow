/**
 * WorkerLauncher — shared helpers to discover, start, fork, stop and clean up
 * remote workers (connected `knowhow worker` machines and Firecracker-sandbox
 * cloud workers). Used by the /workers chat command, `knowhow workers attach`,
 * /offload, and the agent tools / script module.
 *
 * Only talks to existing backend endpoints:
 *   POST /api/cloud-workers/{id}/start   { snapshotId?: string | false }
 *   POST /api/cloud-workers/{id}/stop    { snapshot?: boolean }
 *   GET  /api/sandboxes/{id}/snapshots, GET /api/sandboxes/{id}
 *   POST /api/sandboxes/fork             { snapshotId, name?, cpuCount?, memoryMb?, diskGb? }
 *   POST /api/sandboxes/{id}/checkouts, GET /api/sandboxes/{id}/checkouts/{checkoutId}
 *   DELETE /api/sandboxes/{id}
 */
import {
  KnowhowSimpleClient,
  CloudWorkerRecord,
  CreateSandboxCheckoutBody,
  ForkSandboxBody,
  OrgWorkerInfo,
  SandboxCheckoutRecord,
  SandboxRecord,
  SandboxSnapshotRecord,
} from "./KnowhowClient";
import { RemoteWorker, toRemoteWorkers } from "./RemoteWorkers";
import {
  ensureBaseBundles,
  pushTask,
  resolveLocalTask,
  resolveRepoContext,
} from "./TaskTransport";

export interface SnapshotChoice {
  id: string;
  name?: string;
  createdAt?: string;
  status?: string;
  sizeBytes?: number;
  isDefault?: boolean;
  sandboxId?: string;
}

export interface LaunchTarget {
  kind: "online" | "cloudworker";
  workerId?: string;
  cloudWorkerId?: string;
  name: string;
  status: string;
  sandboxId?: string;
  lastSnapshotId?: string;
}

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
const PROGRESS_EVERY_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** Ready snapshots, newest first, with `isDefault` set for `defaultSnapshotId`. */
export function buildSnapshotChoices(
  snapshots: SandboxSnapshotRecord[],
  defaultSnapshotId?: string | null
): SnapshotChoice[] {
  return snapshots
    .filter((s) => s.status === "ready")
    .slice()
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime()
    )
    .map((s) => ({
      id: s.id,
      name: s.label || undefined,
      createdAt: s.createdAt,
      status: s.status,
      sizeBytes:
        typeof s.sizeBytes === "number" ? s.sizeBytes : undefined,
      isDefault: !!defaultSnapshotId && s.id === defaultSnapshotId,
      sandboxId: s.sandboxId,
    }));
}

/**
 * Snapshots belonging to a cloud worker's lineage: those of its current sandbox
 * plus those of earlier (e.g. destroyed) sandboxes with the same name — a
 * cloud worker gets a fresh sandbox on every cold start, but its checkpoints
 * stay attached to the old ones.
 */
export function lineageSnapshots(
  currentSandboxSnaps: SandboxSnapshotRecord[],
  orgSnaps: SandboxSnapshotRecord[],
  sandboxes: SandboxRecord[],
  cloudWorkerName: string
): SandboxSnapshotRecord[] {
  const ids = new Set(
    sandboxes
      .filter((s) => (s.name ?? "").toLowerCase() === cloudWorkerName.toLowerCase())
      .map((s) => s.id)
  );
  const byId = new Map<string, SandboxSnapshotRecord>();
  for (const s of currentSandboxSnaps) byId.set(s.id, s);
  for (const s of orgSnaps) if (ids.has(s.sandboxId)) byId.set(s.id, s);
  return [...byId.values()];
}

/** The snapshot that a plain start (no snapshotId) would resume from, if any. */
export function pickDefaultSnapshot(
  choices: SnapshotChoice[]
): SnapshotChoice | undefined {
  return choices.find((c) => c.isDefault);
}

/**
 * Merge connected workers + cloud workers into launch targets.
 * - online first, then stopped/starting cloud workers, then (optionally) offline workers
 * - ephemeral CI runner workers/cloud workers are excluded
 * - a cloud worker that has a connected worker is represented by that online target
 */
export function buildLaunchTargets(
  orgWorkers: OrgWorkerInfo[],
  cloudWorkers: CloudWorkerRecord[],
  sandboxes: Record<string, SandboxRecord | undefined> = {},
  opts: { includeOffline?: boolean } = {}
): LaunchTarget[] {
  const cwById = new Map(cloudWorkers.map((c) => [c.id, c]));
  const real = orgWorkers.filter((w) => !w.ephemeral && !w.clientKind);
  const remotes: RemoteWorker[] = toRemoteWorkers(real);

  const online: LaunchTarget[] = [];
  const offline: LaunchTarget[] = [];
  const connectedCloudIds = new Set<string>();
  for (const w of remotes) {
    const cw = w.cloudWorkerId ? cwById.get(w.cloudWorkerId) : undefined;
    if (cw?.isEphemeral) continue;
    // A just-stopped cloud worker's OrgWorker row can stay connected=true for a
    // while; the cloud worker status is the truth, so treat it as stopped.
    if (cw && /^stopped$/i.test(cw.status || "")) continue;
    const target: LaunchTarget = {
      kind: "online",
      workerId: w.id,
      cloudWorkerId: w.cloudWorkerId ?? undefined,
      name: cw?.name || w.label,
      status: w.connected ? "online" : "offline",
      sandboxId: cw?.sandboxId ?? undefined,
    };
    if (w.connected) {
      online.push(target);
      if (w.cloudWorkerId) connectedCloudIds.add(w.cloudWorkerId);
    } else if (opts.includeOffline && !w.cloudWorkerId) {
      // offline cloud-worker rows are represented by their cloud worker below
      offline.push(target);
    }
  }
  online.sort((a, b) => a.name.localeCompare(b.name));

  const cloud: LaunchTarget[] = [];
  for (const cw of cloudWorkers) {
    if (cw.isEphemeral) continue;
    if (connectedCloudIds.has(cw.id)) continue;
    const sb = cw.sandboxId ? sandboxes[cw.sandboxId] : undefined;
    cloud.push({
      kind: "cloudworker",
      cloudWorkerId: cw.id,
      name: cw.name,
      status: String(cw.status || "unknown").toLowerCase(),
      sandboxId: cw.sandboxId ?? undefined,
      lastSnapshotId: sb?.lastSnapshotId ?? undefined,
    });
  }
  cloud.sort((a, b) => a.name.localeCompare(b.name));
  return [...online, ...cloud, ...offline];
}

/** Resolve a cloud worker by id, id prefix, exact name, case-insensitive, substring. */
export function matchCloudWorker(
  cloudWorkers: CloudWorkerRecord[],
  ref: string
): CloudWorkerRecord {
  const q = (ref || "").trim();
  const lower = q.toLowerCase();
  const stages: Array<(c: CloudWorkerRecord) => boolean> = [
    (c) => c.id === q,
    (c) => q.length >= 4 && c.id.toLowerCase().startsWith(lower),
    (c) => c.name === q,
    (c) => c.name.toLowerCase() === lower,
    (c) => c.name.toLowerCase().includes(lower),
  ];
  for (const stage of stages) {
    const found = cloudWorkers.filter(stage);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(
        `Cloud worker reference '${ref}' is ambiguous: ${found
          .map((c) => `${c.name} (${c.id.slice(0, 8)})`)
          .join(", ")}`
      );
    }
  }
  throw new Error(
    `No cloud worker matches '${ref}'. Available: ${
      cloudWorkers.map((c) => c.name).join(", ") || "(none)"
    }`
  );
}

/** Find the connected OrgWorker linked to the given cloud worker (newest first). */
export function findConnectedWorker(
  orgWorkers: OrgWorkerInfo[],
  cloudWorkerId: string
): OrgWorkerInfo | undefined {
  return orgWorkers
    .filter((w) => w.connected && w.cloudWorkerId === cloudWorkerId)
    .sort(
      (a, b) =>
        new Date(b.lastConnected || 0).getTime() -
        new Date(a.lastConnected || 0).getTime()
    )[0];
}

/** Build the POST body for /cloud-workers/{id}/start. */
export function startBody(snapshotId?: string | false): {
  snapshotId?: string | false;
} {
  if (snapshotId === undefined) return {};
  return { snapshotId };
}

export interface ForkResources {
  cpuCount?: number;
  memoryMb?: number;
  diskGb?: number;
}

/**
 * Validate + build the POST body for /sandboxes/fork. Resource overrides are
 * only honoured by the backend for disk (`disk_only`) checkpoints — memory
 * snapshots must restore with their original vCPU/RAM.
 */
export function forkBody(opts: { snapshotId: string; name?: string } & ForkResources): ForkSandboxBody {
  const checks: Array<[keyof ForkResources, number | undefined, number]> = [
    ["cpuCount", opts.cpuCount, 1],
    ["memoryMb", opts.memoryMb, 256],
    ["diskGb", opts.diskGb, 1],
  ];
  for (const [k, v, min] of checks) {
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < min) {
      throw new Error(`${k} must be an integer >= ${min} (got ${String(v)})`);
    }
  }
  const body: ForkSandboxBody = { snapshotId: opts.snapshotId };
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.cpuCount !== undefined) body.cpuCount = opts.cpuCount;
  if (opts.memoryMb !== undefined) body.memoryMb = opts.memoryMb;
  if (opts.diskGb !== undefined) body.diskGb = opts.diskGb;
  return body;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Input accepted by the checkout helpers/tools. Extends the backend body with
 * conveniences resolved client-side by `resolveCheckoutSpec`:
 *  - taskId may be "current" or a local task slug (resolved to the backend UUID)
 *  - pushSnapshot: push a fresh workspace snapshot of the local cwd first (mode A)
 *  - mode B with only commitSha/branch: repositoryId is resolved from the local git repo
 */
export interface CheckoutInput extends CreateSandboxCheckoutBody {
  pushSnapshot?: boolean;
}

/** Check the final (resolved) body against the backend contract. */
export function validateCheckoutBody(spec: CreateSandboxCheckoutBody): void {
  const hasTask = !!spec.taskId;
  const hasRepo = !!spec.repositoryId;
  if (hasTask === hasRepo) {
    throw new Error("checkout: provide exactly one of taskId or repositoryId");
  }
  if (hasRepo && !spec.commitSha && !spec.branch) {
    throw new Error("checkout: repositoryId requires commitSha or branch");
  }
  if (hasTask && (spec.commitSha || spec.branch)) {
    throw new Error("checkout: commitSha/branch cannot be combined with taskId");
  }
  if (spec.commitSha && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(spec.commitSha)) {
    throw new Error("checkout: commitSha must be a full 40 or 64 char sha");
  }
}

/** Drop undefined values + client-only fields to get the wire body. */
export function checkoutWireBody(spec: CheckoutInput): CreateSandboxCheckoutBody {
  const { pushSnapshot: _ignored, ...rest } = spec;
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== null && v !== "") body[k] = v;
  }
  return body as CreateSandboxCheckoutBody;
}

/**
 * Resolve a user-facing checkout input into the backend body:
 *  - taskId "current"/local slug -> backend task UUID (optionally pushing a
 *    fresh workspace snapshot so the sandbox gets the current WIP)
 *  - no taskId/repositoryId but commitSha/branch -> repositoryId from the local
 *    git repo (POST /git-repositories/resolve) after making sure the base
 *    bundles are uploaded so the sandbox can fetch the commit.
 */
export async function resolveCheckoutSpec(
  input: CheckoutInput,
  opts: { cwd?: string; onProgress?: (msg: string) => void } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<CreateSandboxCheckoutBody> {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.onProgress ?? (() => {});
  const spec: CheckoutInput = { ...input };

  if (spec.taskId && !spec.repositoryId) {
    let metadata: Record<string, any> | undefined;
    if (spec.taskId === "current" || !UUID_RE.test(spec.taskId)) {
      const local = resolveLocalTask(spec.taskId === "current" ? undefined : spec.taskId);
      if (!local.remoteId) {
        throw new Error(
          `Task ${local.localId} is not synced to the Knowhow backend yet (no remote task id); enable remote sync first.`
        );
      }
      log(`resolved local task ${local.localId} -> ${local.remoteId}`);
      spec.taskId = local.remoteId;
      metadata = local.metadata;
    }
    if (spec.pushSnapshot) {
      log(`pushing a fresh workspace snapshot for task ${spec.taskId}…`);
      let maxFileMb: number | undefined;
      let configFiles: { localPath: string }[] | undefined;
      try {
        const { getConfig } = await import("../config");
        const config = await getConfig();
        maxFileMb = config.gitPlugin?.maxFileMb;
        configFiles = config.files;
      } catch {
        /* config is optional for the push */
      }
      const pushed = await pushTask(client, spec.taskId, {
        cwd,
        metadata,
        maxFileMb,
        configFiles,
        log,
      });
      const snapId = pushed.created?.id;
      if (snapId && !spec.workspaceSnapshotId) spec.workspaceSnapshotId = snapId;
    }
  } else if (!spec.taskId && !spec.repositoryId) {
    if (!spec.commitSha && !spec.branch) {
      throw new Error(
        "checkout: provide taskId, or repositoryId + commitSha/branch, or commitSha/branch to resolve the repository from the local git repo"
      );
    }
    const ctx = await resolveRepoContext(client, cwd);
    spec.repositoryId = ctx.repo.id;
    log(`resolved repository ${ctx.repo.id} from ${ctx.info.gitRoot}`);
    await ensureBaseBundles(client, ctx.repo, ctx.info, log);
  }
  const body = checkoutWireBody(spec);
  validateCheckoutBody(body);
  return body;
}

// ---------------------------------------------------------------------------
// API-backed functions
// ---------------------------------------------------------------------------

async function fetchCloudWorkers(client: KnowhowSimpleClient) {
  const res = await client.listCloudWorkers();
  return (Array.isArray(res.data) ? res.data : []) as CloudWorkerRecord[];
}

async function fetchOrgWorkers(client: KnowhowSimpleClient) {
  const res = await client.listOrgWorkers();
  return (Array.isArray(res.data) ? res.data : []) as OrgWorkerInfo[];
}

export async function listLaunchTargets(
  opts: { includeOffline?: boolean } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<LaunchTarget[]> {
  const [orgWorkers, cloudWorkers] = await Promise.all([
    fetchOrgWorkers(client),
    fetchCloudWorkers(client),
  ]);
  // Look up sandboxes only for cloud workers that might be launched (not connected)
  const connected = new Set(
    orgWorkers
      .filter((w) => w.connected && w.cloudWorkerId)
      .map((w) => w.cloudWorkerId as string)
  );
  const sandboxes: Record<string, SandboxRecord | undefined> = {};
  await Promise.all(
    cloudWorkers
      .filter((c) => !c.isEphemeral && c.sandboxId && !connected.has(c.id))
      .map(async (c) => {
        try {
          sandboxes[c.sandboxId as string] = (
            await client.getSandbox(c.sandboxId as string)
          ).data;
        } catch {
          /* sandbox may be gone; snapshot default simply unknown */
        }
      })
  );
  return buildLaunchTargets(orgWorkers, cloudWorkers, sandboxes, opts);
}

export async function listSnapshotsForCloudWorker(
  cloudWorkerIdOrName: string,
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<SnapshotChoice[]> {
  const cw = matchCloudWorker(await fetchCloudWorkers(client), cloudWorkerIdOrName);
  let defaultId: string | null | undefined;
  let current: SandboxSnapshotRecord[] = [];
  if (cw.sandboxId) {
    try {
      defaultId = (await client.getSandbox(cw.sandboxId)).data.lastSnapshotId;
    } catch {
      /* sandbox record gone - snapshots can still be listed */
    }
    try {
      const r = (await client.listSandboxSnapshots(cw.sandboxId)).data;
      current = Array.isArray(r) ? r : [];
    } catch {
      /* ignore */
    }
  }
  let orgSnaps: SandboxSnapshotRecord[] = [];
  let sandboxes: SandboxRecord[] = [];
  try {
    const [o, sb] = await Promise.all([client.listOrgSnapshots(), client.listSandboxes()]);
    orgSnaps = Array.isArray(o.data) ? o.data : [];
    sandboxes = Array.isArray(sb.data) ? sb.data : [];
    // GET /sandboxes omits destroyed sandboxes, but their records (and names)
    // can still be fetched individually — that is where older checkpoints live.
    const known = new Set(sandboxes.map((x) => x.id));
    const unknown = [...new Set(orgSnaps.map((x) => x.sandboxId))].filter((id) => !known.has(id));
    const fetched = await Promise.all(
      unknown.map(async (id) => {
        try {
          return (await client.getSandbox(id)).data;
        } catch {
          return undefined;
        }
      })
    );
    sandboxes = [...sandboxes, ...fetched.filter((x): x is SandboxRecord => !!x)];
  } catch {
    /* lineage is best-effort */
  }
  return buildSnapshotChoices(
    lineageSnapshots(current, orgSnaps, sandboxes, cw.name),
    defaultId
  );
}

interface WaitOpts {
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

/** Poll until a connected worker linked to the cloud worker (found by `locate`) appears. */
async function waitForWorker(
  client: KnowhowSimpleClient,
  locate: () => Promise<{ cloudWorkerId?: string; status?: string; name?: string; sandboxId?: string }>,
  what: string,
  opts: WaitOpts
): Promise<{ cloudWorkerId?: string; workerId?: string; name?: string; sandboxId?: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let lastProgress = 0;
  let last: { cloudWorkerId?: string; status?: string; name?: string; sandboxId?: string } = {};
  while (Date.now() - started < timeoutMs) {
    try {
      last = await locate();
      if (last.cloudWorkerId) {
        const w = findConnectedWorker(
          await fetchOrgWorkers(client),
          last.cloudWorkerId
        );
        if (w) {
          return {
            cloudWorkerId: last.cloudWorkerId,
            workerId: w.id,
            name: last.name,
            sandboxId: last.sandboxId,
          };
        }
      }
      if (/^(error|failed)$/i.test(last.status || "")) {
        throw new Error(`${what} failed to start (status: ${last.status})`);
      }
    } catch (e: any) {
      if (/failed to start/.test(e?.message || "")) throw e;
      /* transient — keep polling */
    }
    if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = Date.now();
      opts.onProgress?.(
        `waiting for ${what} to connect… (${Math.round(
          (Date.now() - started) / 1000
        )}s, status: ${last.status ?? "unknown"})`
      );
    }
    await sleep(2500);
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} to connect (last status: ${
      last.status ?? "unknown"
    })`
  );
}

export interface CheckoutResult {
  checkoutId: string;
  sandboxId: string;
  repoDir?: string;
  cwd?: string;
  commitSha?: string;
  branch?: string;
  verified?: boolean | null;
}

/**
 * Create a checkout in a RUNNING sandbox (POST /sandboxes/{id}/checkouts) and
 * poll until it succeeds. Throws on failure with the error and the log tail.
 * `spec` must already be a valid backend body (see resolveCheckoutSpec for the
 * ergonomic resolution of "current" tasks / local repo).
 */
export async function checkoutInSandbox(
  sandboxId: string,
  spec: CreateSandboxCheckoutBody,
  opts: { timeoutMs?: number; pollMs?: number; onProgress?: (msg: string) => void } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<CheckoutResult> {
  validateCheckoutBody(spec);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = opts.pollMs ?? 2000;
  opts.onProgress?.(`creating checkout in sandbox ${sandboxId}…`);
  const created = (await client.createSandboxCheckout(sandboxId, spec)).data;
  const checkoutId = created?.id;
  if (!checkoutId) {
    throw new Error(
      `Checkout did not return an id: ${JSON.stringify(created).slice(0, 200)}`
    );
  }
  const started = Date.now();
  let lastProgress = 0;
  let cur: SandboxCheckoutRecord | undefined;
  let lastErr: any;
  while (Date.now() - started < timeoutMs) {
    try {
      cur = (await client.getSandboxCheckout(sandboxId, checkoutId)).data;
      lastErr = undefined;
    } catch (e: any) {
      lastErr = e; // transient — keep polling until the deadline
    }
    if (cur?.status === "succeeded") {
      opts.onProgress?.(`checkout ${checkoutId} succeeded`);
      return {
        checkoutId,
        sandboxId,
        repoDir: cur.repoDir,
        cwd: cur.cwd,
        commitSha: cur.commitSha,
        branch: cur.branch,
        verified: cur.verified,
      };
    }
    if (cur?.status === "failed") {
      throw new Error(
        `Checkout ${checkoutId} failed: ${cur.error || "unknown error"}${
          cur.logTail ? `\n--- log tail ---\n${cur.logTail}` : ""
        }`
      );
    }
    if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = Date.now();
      opts.onProgress?.(
        `waiting for checkout ${checkoutId}… (${Math.round(
          (Date.now() - started) / 1000
        )}s, status: ${cur?.status ?? "unknown"})`
      );
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for checkout ${checkoutId} (last status: ${
      cur?.status ?? "unknown"
    }${lastErr ? `, last error: ${lastErr?.message ?? lastErr}` : ""})`
  );
}

/** Resolve (see resolveCheckoutSpec) then run a checkout; the one-call ergonomic entry point. */
export async function checkoutResolved(
  sandboxId: string,
  input: CheckoutInput,
  opts: {
    cwd?: string;
    timeoutMs?: number;
    pollMs?: number;
    onProgress?: (msg: string) => void;
  } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<CheckoutResult> {
  const body = await resolveCheckoutSpec(input, opts, client);
  return checkoutInSandbox(sandboxId, body, opts, client);
}

/** Checkout after a launch; a failure names the (still running) sandbox so the caller can destroy it. */
async function checkoutAfterLaunch(
  sandboxId: string | undefined,
  input: CheckoutInput,
  opts: { timeoutMs?: number; onProgress?: (msg: string) => void },
  client: KnowhowSimpleClient
): Promise<CheckoutResult> {
  if (!sandboxId) {
    throw new Error("checkout: could not determine the sandbox id of the launched worker");
  }
  try {
    return await checkoutResolved(sandboxId, input, opts, client);
  } catch (e: any) {
    throw new Error(
      `${e?.message ?? e}\n(sandbox ${sandboxId} is still running — destroy it with destroyForkedSandbox if you no longer need it)`
    );
  }
}

/** Sandbox id of a cloud worker (by id/name); throws if it has no live sandbox. */
export async function sandboxIdForCloudWorker(
  cloudWorkerIdOrName: string,
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<string> {
  const cw = matchCloudWorker(await fetchCloudWorkers(client), cloudWorkerIdOrName);
  if (!cw.sandboxId) {
    throw new Error(
      `Cloud worker ${cw.name} has no sandbox (status: ${cw.status}); start it first`
    );
  }
  return cw.sandboxId;
}

export interface StartCloudWorkerResult {
  cloudWorkerId: string;
  workerId?: string;
  name: string;
  /** current sandbox of the cloud worker, when known */
  sandboxId?: string;
  /** present only when a `checkout` was requested */
  checkout?: CheckoutResult;
}

export async function startCloudWorker(
  cloudWorkerIdOrName: string,
  opts: {
    snapshotId?: string | false;
    waitForConnect?: boolean;
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
    /** run a checkout in the sandbox once connected (requires waitForConnect) */
    checkout?: CheckoutInput;
  } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<StartCloudWorkerResult> {
  if (opts.checkout && opts.waitForConnect === false) {
    throw new Error("checkout requires waitForConnect (the sandbox must be running)");
  }
  const cw = matchCloudWorker(await fetchCloudWorkers(client), cloudWorkerIdOrName);

  // no-op if already running + connected
  const existing = findConnectedWorker(await fetchOrgWorkers(client), cw.id);
  if (existing && /running/i.test(cw.status)) {
    opts.onProgress?.(`${cw.name} is already running and connected`);
    const base: StartCloudWorkerResult = {
      cloudWorkerId: cw.id,
      workerId: existing.id,
      name: cw.name,
      sandboxId: cw.sandboxId ?? undefined,
    };
    if (opts.checkout) {
      base.checkout = await checkoutAfterLaunch(base.sandboxId, opts.checkout, opts, client);
    }
    return base;
  }

  const desc =
    opts.snapshotId === false
      ? "fresh cold start"
      : typeof opts.snapshotId === "string"
      ? `snapshot ${opts.snapshotId}`
      : "default resume";
  opts.onProgress?.(`starting ${cw.name} (${desc})…`);
  await client.startCloudWorkerRaw(cw.id, startBody(opts.snapshotId));

  if (opts.waitForConnect === false) {
    return { cloudWorkerId: cw.id, name: cw.name };
  }
  const found = await waitForWorker(
    client,
    async () => {
      const cur = (await fetchCloudWorkers(client)).find((c) => c.id === cw.id);
      return {
        cloudWorkerId: cw.id,
        status: cur?.status,
        name: cw.name,
        sandboxId: cur?.sandboxId ?? undefined,
      };
    },
    cw.name,
    opts
  );
  opts.onProgress?.(`${cw.name} connected`);
  const result: StartCloudWorkerResult = {
    cloudWorkerId: cw.id,
    workerId: found.workerId,
    name: cw.name,
    sandboxId: found.sandboxId,
  };
  if (opts.checkout) {
    result.checkout = await checkoutAfterLaunch(found.sandboxId, opts.checkout, opts, client);
  }
  return result;
}

export interface ForkResult {
  sandboxId: string;
  cloudWorkerId?: string;
  workerId?: string;
  name: string;
  cpuCount?: number;
  memoryMb?: number;
  diskGb?: number;
  /** present only when a `checkout` was requested */
  checkout?: CheckoutResult;
}

/**
 * Fork a NEW sandbox from a snapshot. cpuCount/memoryMb/diskGb resize the fork
 * but only work for disk checkpoints (disk_only) — memory snapshots restore via
 * Firecracker /snapshot/load with their original vCPU/RAM and the backend
 * rejects a mismatch with a 400.
 */
export async function forkFromSnapshot(
  opts: {
    snapshotId: string;
    name?: string;
    cpuCount?: number;
    memoryMb?: number;
    diskGb?: number;
    waitForConnect?: boolean;
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
    /** run a checkout in the sandbox once connected (requires waitForConnect) */
    checkout?: CheckoutInput;
  },
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<ForkResult> {
  if (opts.checkout && opts.waitForConnect === false) {
    throw new Error("checkout requires waitForConnect (the sandbox must be running)");
  }
  const body = forkBody(opts);
  const sizing = ["cpuCount", "memoryMb", "diskGb"]
    .filter((k) => (body as any)[k] !== undefined)
    .map((k) => `${k}=${(body as any)[k]}`)
    .join(", ");
  opts.onProgress?.(
    `forking a new sandbox from snapshot ${opts.snapshotId}${sizing ? ` (${sizing})` : ""}…`
  );
  // The backend returns the sandbox record at the top level.
  const sandbox = (await client.forkSandboxFromSnapshot(body)).data;
  const sandboxId = sandbox?.id;
  if (!sandboxId) {
    throw new Error(
      `Fork did not return a sandbox id: ${JSON.stringify(sandbox).slice(0, 200)}`
    );
  }
  const name: string = sandbox.name || opts.name || sandboxId;
  const sizeInfo = {
    ...(typeof sandbox.cpuCount === "number" && { cpuCount: sandbox.cpuCount }),
    ...(typeof sandbox.memoryMb === "number" && { memoryMb: sandbox.memoryMb }),
    ...(typeof sandbox.diskGb === "number" && { diskGb: sandbox.diskGb }),
  };
  opts.onProgress?.(`created sandbox ${sandboxId} (${name})`);

  if (opts.waitForConnect === false) return { sandboxId, name, ...sizeInfo };

  const found = await waitForWorker(
    client,
    async () => {
      const cw = (await fetchCloudWorkers(client)).find(
        (c) => c.sandboxId === sandboxId
      );
      return { cloudWorkerId: cw?.id, status: cw?.status, name: cw?.name || name };
    },
    `forked sandbox ${name}`,
    opts
  );
  opts.onProgress?.(`${name} connected`);
  const result: ForkResult = {
    sandboxId,
    cloudWorkerId: found.cloudWorkerId,
    workerId: found.workerId,
    name: found.name || name,
    ...sizeInfo,
  };
  if (opts.checkout) {
    result.checkout = await checkoutAfterLaunch(sandboxId, opts.checkout, opts, client);
  }
  return result;
}

export async function stopCloudWorker(
  idOrName: string,
  opts: { snapshot?: boolean } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<void> {
  const cw = matchCloudWorker(await fetchCloudWorkers(client), idOrName);
  await client.stopCloudWorkerRaw(cw.id, { snapshot: !!opts.snapshot });
}

export async function destroyForkedSandbox(
  sandboxId: string,
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<void> {
  // Forks (sandboxes with a baseSnapshotId) also leave a STOPPED cloud-worker
  // record behind once destroyed; remove it so it doesn't clutter the worker list.
  let isFork = false;
  try {
    isFork = !!(await client.getSandbox(sandboxId)).data.baseSnapshotId;
  } catch {
    /* sandbox lookup is best-effort */
  }
  let cwId: string | undefined;
  if (isFork) {
    try {
      cwId = (await fetchCloudWorkers(client)).find((c) => c.sandboxId === sandboxId)?.id;
    } catch {
      /* ignore */
    }
  }
  await client.destroySandbox(sandboxId);
  if (cwId) {
    try {
      await client.deleteCloudWorkerRaw(cwId);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Wait for an already-starting cloud worker to have a connected worker (no start request). */
export async function waitForCloudWorkerConnected(
  cloudWorkerId: string,
  opts: { timeoutMs?: number; onProgress?: (msg: string) => void } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<{ cloudWorkerId: string; workerId?: string; name: string }> {
  const found = await waitForWorker(
    client,
    async () => {
      const cur = (await fetchCloudWorkers(client)).find((c) => c.id === cloudWorkerId);
      return { cloudWorkerId, status: cur?.status, name: cur?.name };
    },
    "cloud worker",
    opts
  );
  return { cloudWorkerId, workerId: found.workerId, name: found.name || cloudWorkerId };
}
