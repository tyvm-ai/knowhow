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
 *   POST /api/sandboxes/fork             { snapshotId, name? }
 *   DELETE /api/sandboxes/{id}
 */
import {
  KnowhowSimpleClient,
  CloudWorkerRecord,
  OrgWorkerInfo,
  SandboxRecord,
  SandboxSnapshotRecord,
} from "./KnowhowClient";
import { RemoteWorker, toRemoteWorkers } from "./RemoteWorkers";

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
  locate: () => Promise<{ cloudWorkerId?: string; status?: string; name?: string }>,
  what: string,
  opts: WaitOpts
): Promise<{ cloudWorkerId?: string; workerId?: string; name?: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let lastProgress = 0;
  let last: { cloudWorkerId?: string; status?: string; name?: string } = {};
  while (Date.now() - started < timeoutMs) {
    try {
      last = await locate();
      if (last.cloudWorkerId) {
        const w = findConnectedWorker(
          await fetchOrgWorkers(client),
          last.cloudWorkerId
        );
        if (w) return { cloudWorkerId: last.cloudWorkerId, workerId: w.id, name: last.name };
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

export async function startCloudWorker(
  cloudWorkerIdOrName: string,
  opts: {
    snapshotId?: string | false;
    waitForConnect?: boolean;
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
  } = {},
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<{ cloudWorkerId: string; workerId?: string; name: string }> {
  const cw = matchCloudWorker(await fetchCloudWorkers(client), cloudWorkerIdOrName);

  // no-op if already running + connected
  const existing = findConnectedWorker(await fetchOrgWorkers(client), cw.id);
  if (existing && /running/i.test(cw.status)) {
    opts.onProgress?.(`${cw.name} is already running and connected`);
    return { cloudWorkerId: cw.id, workerId: existing.id, name: cw.name };
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
      return { cloudWorkerId: cw.id, status: cur?.status, name: cw.name };
    },
    cw.name,
    opts
  );
  opts.onProgress?.(`${cw.name} connected`);
  return { cloudWorkerId: cw.id, workerId: found.workerId, name: cw.name };
}

export async function forkFromSnapshot(
  opts: {
    snapshotId: string;
    name?: string;
    waitForConnect?: boolean;
    timeoutMs?: number;
    onProgress?: (msg: string) => void;
  },
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<{
  sandboxId: string;
  cloudWorkerId?: string;
  workerId?: string;
  name: string;
}> {
  opts.onProgress?.(`forking a new sandbox from snapshot ${opts.snapshotId}…`);
  const res = (
    await client.forkSandboxFromSnapshot({
      snapshotId: opts.snapshotId,
      name: opts.name,
    })
  ).data;
  const sandbox = res?.sandbox ?? res;
  const sandboxId: string | undefined = sandbox?.id;
  if (!sandboxId) {
    throw new Error(
      `Fork did not return a sandbox id: ${JSON.stringify(res).slice(0, 200)}`
    );
  }
  const name: string = sandbox?.name || opts.name || sandboxId;
  opts.onProgress?.(`created sandbox ${sandboxId} (${name})`);

  if (opts.waitForConnect === false) return { sandboxId, name };

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
  return {
    sandboxId,
    cloudWorkerId: found.cloudWorkerId,
    workerId: found.workerId,
    name: found.name || name,
  };
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
