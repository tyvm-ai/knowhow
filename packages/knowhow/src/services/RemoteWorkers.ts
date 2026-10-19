import { KnowhowSimpleClient, OrgWorkerInfo } from "./KnowhowClient";
import { lastAssistantText } from "../agents/tools/waitForAgentCompleted";

export type WorkerOs = "windows" | "posix" | "unknown";

export interface RemoteWorker extends OrgWorkerInfo {
  /** hostname parsed from userAgent (fallback: id.slice(0,8)) */
  name: string;
  os: WorkerOs;
  /** last path segment of fsRoot ("" for "~") */
  folder: string;
  cliVersion?: string;
  /** `name`, or `name:folder` when several workers share the same host */
  label: string;
}

export interface WorkerSummary {
  id: string;
  name: string;
  os: WorkerOs;
  root: string;
  connected: boolean;
  status: "online" | "offline";
  shared: boolean;
  owner?: string;
  cloudWorkerId: string | null;
  lastConnected: string;
  clientKind?: string | null;
}

export function parseWorkerUserAgent(ua: string): {
  client: string;
  version?: string;
  hostname?: string;
} {
  const parts = (ua || "").split("/");
  if (parts.length >= 3) {
    return {
      client: parts[0],
      version: parts[1],
      hostname: parts.slice(2).join("/"),
    };
  }
  if (parts.length === 2) {
    return { client: parts[0], hostname: parts[1] };
  }
  return { client: parts[0] || "" };
}

export function inferWorkerOs(fsRoot: string): WorkerOs {
  const root = fsRoot || "";
  if (/^[A-Za-z]:[\\/]/.test(root) || root.includes("\\")) return "windows";
  if (root.startsWith("/") || root.startsWith("~")) return "posix";
  return "unknown";
}

function folderOf(fsRoot: string): string {
  const root = (fsRoot || "").replace(/[\\/]+$/, "");
  if (!root || root === "~") return "";
  const segs = root.split(/[\\/]/);
  const last = segs[segs.length - 1];
  return /^[A-Za-z]:$/.test(last) ? "" : last;
}

export function toRemoteWorkers(infos: OrgWorkerInfo[]): RemoteWorker[] {
  const mapped = infos.map((w) => {
    const ua = parseWorkerUserAgent(w.userAgent);
    const name = ua.hostname || w.id.slice(0, 8);
    return {
      ...w,
      name,
      os: inferWorkerOs(w.fsRoot),
      folder: folderOf(w.fsRoot),
      cliVersion: ua.version,
      label: name,
    } as RemoteWorker;
  });
  const counts = new Map<string, number>();
  for (const w of mapped) {
    const k = w.name.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const w of mapped) {
    if ((counts.get(w.name.toLowerCase()) || 0) > 1 && w.folder) {
      w.label = `${w.name}:${w.folder}`;
    }
  }
  return mapped;
}

export async function listRemoteWorkers(
  client: KnowhowSimpleClient = new KnowhowSimpleClient(),
  opts: { all?: boolean; includeClients?: boolean } = {}
): Promise<RemoteWorker[]> {
  const res = await client.listOrgWorkers({
    includeClients: opts.includeClients,
  });
  let infos = (Array.isArray(res?.data) ? res.data : []) as OrgWorkerInfo[];
  if (!opts.all) infos = infos.filter((w) => w.connected);
  if (!opts.includeClients) {
    infos = infos.filter((w) => !w.ephemeral && !w.clientKind);
  }
  const workers = toRemoteWorkers(infos);
  workers.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return (
      new Date(b.lastConnected || 0).getTime() -
      new Date(a.lastConnected || 0).getTime()
    );
  });
  return workers;
}

export function summarizeWorker(w: RemoteWorker): WorkerSummary {
  return {
    id: w.id,
    name: w.name,
    os: w.os,
    root: w.fsRoot,
    connected: !!w.connected,
    status: w.connected ? "online" : "offline",
    shared: !!w.shared,
    owner: w.user?.name || w.user?.email,
    cloudWorkerId: w.cloudWorkerId ?? null,
    lastConnected: w.lastConnected,
    clientKind: w.clientKind,
  };
}

export async function resolveWorker(
  ref: string,
  client: KnowhowSimpleClient = new KnowhowSimpleClient(),
  opts: { allowOffline?: boolean } = {}
): Promise<RemoteWorker> {
  const all = await listRemoteWorkers(client, {
    all: true,
    includeClients: false,
  });
  const q = (ref || "").trim();
  const lower = q.toLowerCase();
  const describe = (w: RemoteWorker) =>
    `  ${w.id.slice(0, 8)}  ${w.name}  ${w.fsRoot}`;

  const stages: Array<(w: RemoteWorker) => boolean> = [
    (w) => w.id === q,
    (w) => q.length >= 4 && w.id.toLowerCase().startsWith(lower),
    (w) => w.name.toLowerCase() === lower,
    (w) => w.label.toLowerCase() === lower || `${w.name}:${w.folder}`.toLowerCase() === lower,
    (w) => w.name.toLowerCase().includes(lower),
  ];

  let matched: RemoteWorker | undefined;
  if (q) {
    for (const stage of stages) {
      let found = all.filter(stage);
      if (found.length === 0) continue;
      if (found.length > 1) {
        // Prefer online workers when disambiguating
        const online = found.filter((w) => w.connected);
        if (online.length === 1) found = online;
      }
      if (found.length > 1) {
        throw new Error(
          `Worker reference '${ref}' is ambiguous. Candidates:\n${found
            .map(describe)
            .join("\n")}\nUse the id (or id prefix) to be specific.`
        );
      }
      matched = found[0];
      break;
    }
  }
  if (!matched) {
    throw new Error(
      `No worker matches '${ref}'. Run: knowhow workers list --all`
    );
  }
  if (!matched.connected && !opts.allowOffline) {
    throw new Error(
      `Worker ${matched.name} (${matched.id.slice(0, 8)}) is offline (last seen ${matched.lastConnected})`
    );
  }
  return matched;
}

export function unwrapToolResponse(envelope: any): any {
  let resp = envelope;
  if (envelope && typeof envelope === "object" && "functionResp" in envelope) {
    resp = envelope.functionResp;
  } else if (envelope && typeof envelope === "object" && envelope.toolMessages) {
    const msg = envelope.toolMessages?.[0];
    resp = msg?.content ?? envelope;
  }
  if (typeof resp === "string") {
    try {
      resp = JSON.parse(resp);
    } catch {
      /* keep raw string */
    }
  }
  if (resp && typeof resp === "object" && resp.error === "WORKER_LOCKED") {
    throw new Error(
      "Worker is locked (passkey). Unlock it first (open the web app > Workers > unlock) and retry."
    );
  }
  return resp;
}

function errorText(e: any): string {
  const body = e?.body;
  const parts = [
    e?.message,
    body?.message,
    body?.error,
    typeof body === "string" ? body : undefined,
  ].filter(Boolean);
  return parts.join(" | ");
}

const toolNameCache = new Map<string, Map<string, string>>();

/** @internal for tests */
export function _clearToolNameCache() {
  toolNameCache.clear();
}

function looksLikeToolNotFound(e: any): boolean {
  const t = errorText(e).toLowerCase();
  return (
    /not found|not enabled|unknown tool|no such tool|not allowed|not exposed/.test(
      t
    ) && /tool|function/.test(t)
  );
}

export async function callWorkerTool(
  client: KnowhowSimpleClient,
  workerId: string,
  toolName: string,
  args: any
): Promise<any> {
  const cached = toolNameCache.get(workerId)?.get(toolName);
  const first = cached || `worker_0_${toolName}`;
  try {
    const res = await client.callWorkerToolRaw(workerId, first, args);
    return unwrapToolResponse(res?.data);
  } catch (e: any) {
    if (!looksLikeToolNotFound(e)) {
      const msg = errorText(e);
      throw new Error(`Worker tool call '${toolName}' failed: ${msg}`);
    }
  }

  // Fallback: discover the real tool name
  let defs: Array<{ function: { name: string } }> = [];
  try {
    const res = await client.listWorkerTools(workerId);
    defs = (Array.isArray(res?.data) ? res.data : []) as any;
  } catch {
    /* ignore; error below */
  }
  const found = defs.find(
    (d) =>
      d.function?.name === toolName ||
      d.function?.name?.endsWith(`_${toolName}`)
  );
  if (!found) {
    throw new Error(
      `Tool '${toolName}' is not exposed by this worker. Add it to worker.allowedTools in the worker's knowhow.json and restart/reload (tool: reloadConfig).`
    );
  }
  if (!toolNameCache.has(workerId)) toolNameCache.set(workerId, new Map());
  toolNameCache.get(workerId)!.set(toolName, found.function.name);
  try {
    const res = await client.callWorkerToolRaw(
      workerId,
      found.function.name,
      args
    );
    return unwrapToolResponse(res?.data);
  } catch (e: any) {
    throw new Error(`Worker tool call '${toolName}' failed: ${errorText(e)}`);
  }
}


export async function execOnWorker(
  client: KnowhowSimpleClient,
  worker: RemoteWorker | string,
  command: string,
  timeoutMs = 25000,
  extra: { continueInBackground?: boolean; logFileName?: string } = {}
): Promise<{
  stdout: string;
  stderr?: string;
  exitCode?: number;
  raw: any;
}> {
  const id = typeof worker === "string" ? worker : worker.id;
  const raw = await callWorkerTool(client, id, "execCommand", {
    command,
    timeout: timeoutMs,
    ...extra,
  });
  if (typeof raw === "string") return { stdout: raw, raw };
  if (raw && typeof raw === "object") {
    if (raw.error && !("stdout" in raw)) {
      throw new Error(
        typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error)
      );
    }
    return {
      stdout:
        typeof raw.stdout === "string"
          ? raw.stdout
          : typeof raw.output === "string"
          ? raw.output
          : JSON.stringify(raw),
      stderr: typeof raw.stderr === "string" ? raw.stderr : undefined,
      exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
      raw,
    };
  }
  return { stdout: String(raw ?? ""), raw };
}

export async function probeWorkerOs(
  client: KnowhowSimpleClient,
  worker: RemoteWorker
): Promise<{ platform: string; arch?: string; hostname?: string } | null> {
  try {
    const r = await execOnWorker(
      client,
      worker,
      `node -e "console.log(process.platform+' '+process.arch)"`,
      8000
    );
    const m = r.stdout.trim().split(/\s+/);
    if (!m[0]) return null;
    return { platform: m[0], arch: m[1], hostname: worker.name };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Remote agent tasks
// ---------------------------------------------------------------------------

export interface StartRemoteTaskParams {
  worker: string | RemoteWorker;
  prompt: string;
  agentName?: string;
  provider?: string;
  model?: string;
  maxTimeLimit?: number;
  maxSpendLimit?: number;
  /** continue an existing remote task on the same worker */
  resumeTaskId?: string;
  title?: string;
  parentTaskId?: string;
}

export interface StartRemoteTaskResult {
  success: boolean;
  taskId: string;
  workerId: string;
  workerName: string;
  sessionId?: string;
  messageId?: string;
  resumed: boolean;
  startResult: any;
}

const num = (v: any) => (typeof v === "number" && !isNaN(v) ? v : undefined);

export async function startRemoteAgentTask(
  params: StartRemoteTaskParams,
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
): Promise<StartRemoteTaskResult> {
  const w =
    typeof params.worker === "string"
      ? await resolveWorker(params.worker, client)
      : params.worker;

  let taskId: string | undefined;
  let sessionId: string | undefined;
  let messageId: string | undefined;
  const resumed = !!params.resumeTaskId;

  if (params.resumeTaskId) {
    taskId = stripRemotePrefix(params.resumeTaskId);
  } else {
    const session = await client.createSessionPlaceholder({
      title: (params.title ?? params.prompt).slice(0, 80),
      workerId: w.id,
      metadata: { source: "cli-remote-worker" },
    } as any);
    sessionId = session.sessionId;
    const msg = await client.createMessagePlaceholder(sessionId, {
      content: params.prompt,
      agentName: params.agentName,
      modelName: params.model,
      metadata: { source: "cli-remote-worker", worker: w.id },
    } as any);
    messageId = msg.messageId;
    taskId = msg.taskId;
    if (!taskId) {
      throw new Error(
        "Backend did not return a taskId for the remote message placeholder"
      );
    }
  }

  const startArgs: any = {
    prompt: params.prompt,
    taskId,
    syncRemote: true,
    syncFs: true,
    agentName: params.agentName,
    provider: params.provider,
    model: params.model,
    maxTimeLimit: num(params.maxTimeLimit),
    maxSpendLimit: num(params.maxSpendLimit),
    ...(resumed ? { resume: true } : {}),
  };
  for (const k of Object.keys(startArgs)) {
    if (startArgs[k] === undefined) delete startArgs[k];
  }

  const startResult = await callWorkerTool(
    client,
    w.id,
    "startAgentTask",
    startArgs
  );
  if (
    startResult &&
    typeof startResult === "object" &&
    (startResult.success === false || (startResult.error && !startResult.success))
  ) {
    const logHint = startResult.logPath
      ? ` (worker log: ${startResult.logPath} on the worker; read it with: knowhow workers exec ${w.name} -- cat ${startResult.logPath})`
      : "";
    throw new Error(
      `Worker ${w.name} failed to start the agent: ${
        startResult.error || "unknown error"
      }${logHint}`
    );
  }
  if (typeof startResult === "string" && /error/i.test(startResult.slice(0, 40))) {
    throw new Error(`Worker ${w.name} failed to start the agent: ${startResult}`);
  }

  return {
    success: true,
    taskId: taskId!,
    workerId: w.id,
    workerName: w.name,
    sessionId,
    messageId,
    resumed,
    startResult,
  };
}

export async function getRemoteTaskStatus(
  taskId: string,
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
) {
  const res = await client.getTaskDetails(stripRemotePrefix(taskId), false);
  return res.data;
}

/**
 * After resuming a finished task, the backend still reports it as completed
 * until the worker's resumed agent syncs. Poll until it is running again so a
 * following /attach doesn't see a stale terminal status. Returns true if the
 * task went back to running within the timeout.
 */
export async function waitForRemoteTaskRunning(
  taskId: string,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    client?: KnowhowSimpleClient;
  } = {}
): Promise<boolean> {
  const client = opts.client ?? new KnowhowSimpleClient();
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  const interval = Math.max(500, opts.pollIntervalMs ?? 1500);
  while (Date.now() < deadline) {
    try {
      const d = (await client.getTaskDetails(stripRemotePrefix(taskId), false))
        .data;
      if (d.inProgress === true || d.status === "running") return true;
    } catch {
      /* transient */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export interface RemoteWaitResult {
  taskId: string;
  status: string;
  costUsd: number;
  finalAnswer?: string;
  timedOut?: boolean;
  elapsedMs: number;
  error?: string;
}

/**
 * Extract the final answer from remote threads. Agents usually finish by
 * calling the finalAnswer tool (stored as a `tool` message / tool_call), so
 * prefer that, then fall back to the last assistant text.
 */
export function extractRemoteFinalAnswer(threads: any): string | undefined {
  const messages: any[] = Array.isArray(threads)
    ? threads.length && Array.isArray(threads[0])
      ? threads.flat()
      : threads
    : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool" && m?.name === "finalAnswer") {
      const c =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (c && c.trim()) return c.trim();
    }
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.function?.name === "finalAnswer") {
          try {
            const a = JSON.parse(tc.function.arguments || "{}");
            if (typeof a.answer === "string" && a.answer.trim()) {
              return a.answer.trim();
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return lastAssistantText(messages);
}

const TERMINAL = new Set(["completed", "killed", "failed", "error", "done"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForRemoteTask(
  taskId: string,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    startupTimeoutMs?: number;
    onPoll?: (d: any) => void;
    client?: KnowhowSimpleClient;
  } = {}
): Promise<RemoteWaitResult> {
  const client = opts.client ?? new KnowhowSimpleClient();
  const id = stripRemotePrefix(taskId);
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const interval = Math.max(1000, opts.pollIntervalMs ?? 3000);
  const startupTimeoutMs = opts.startupTimeoutMs ?? 90_000;
  const started = Date.now();
  let cost = 0;
  let startupChecked = false;

  const finish = async (status: string, extra: Partial<RemoteWaitResult> = {}) => {
    let finalAnswer: string | undefined;
    try {
      const full = (await client.getTaskDetails(id, true)).data;
      cost = full.totalUsdCost ?? cost;
      finalAnswer = full.result ?? extractRemoteFinalAnswer(full.threads);
    } catch {
      /* ignore */
    }
    return {
      taskId: id,
      status,
      costUsd: cost,
      finalAnswer,
      elapsedMs: Date.now() - started,
      ...extra,
    } as RemoteWaitResult;
  };

  while (true) {
    let d: any;
    try {
      d = (await client.getTaskDetails(id, false)).data;
    } catch (e: any) {
      // transient errors: keep polling until the deadline, but a 404 is fatal
      if (e?.status === 404) {
        return {
          taskId: id,
          status: "failed",
          costUsd: cost,
          elapsedMs: Date.now() - started,
          error: `Remote task ${id} not found`,
        };
      }
      d = undefined;
    }
    if (d) {
      cost = d.totalUsdCost ?? cost;
      opts.onPoll?.(d);
      const status: string = d.status;
      if ((status && TERMINAL.has(status)) || d.inProgress === false) {
        return finish(status && TERMINAL.has(status) ? status : "completed");
      }
    }

    const elapsed = Date.now() - started;
    if (!startupChecked && elapsed >= startupTimeoutMs) {
      startupChecked = true;
      try {
        const full = (await client.getTaskDetails(id, true)).data;
        const hasThreads =
          Array.isArray(full.threads) &&
          full.threads.some((t: any) => Array.isArray(t) && t.length > 0);
        if (!hasThreads) {
          return {
            taskId: id,
            status: "failed",
            costUsd: full.totalUsdCost ?? cost,
            elapsedMs: elapsed,
            error:
              "Remote agent never reported progress (check worker log: knowhow workers exec <worker> -- <cat|type> .knowhow/processes/agents/" +
              id +
              ")",
          };
        }
      } catch {
        /* ignore */
      }
    }
    if (elapsed >= timeoutMs) {
      const r = await finish(d?.status ?? "running", {
        timedOut: true,
      });
      return r;
    }
    await sleep(Math.min(interval, Math.max(0, timeoutMs - elapsed)));
  }
}

export async function sendRemoteTaskMessage(
  taskId: string,
  message: string,
  role: "user" | "system" = "user",
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
) {
  return client.sendMessageToAgent(stripRemotePrefix(taskId), message, role);
}

export async function killRemoteTask(
  taskId: string,
  client: KnowhowSimpleClient = new KnowhowSimpleClient()
) {
  return client.killAgent(stripRemotePrefix(taskId));
}

const UUID_RE =
  /^(remote:)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRemoteTaskId(id: string): boolean {
  return UUID_RE.test(id || "");
}

export function stripRemotePrefix(id: string): string {
  return (id || "").replace(/^remote:/i, "");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function relativeTime(ts?: string, now = Date.now()): string {
  if (!ts) return "-";
  const t = new Date(ts).getTime();
  if (isNaN(t)) return "-";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatWorkerTable(
  workers: RemoteWorker[],
  probes: Record<string, { platform: string; arch?: string } | null> = {}
): string {
  const osLabel = (w: RemoteWorker) => {
    const p = probes[w.id];
    if (p) return p.arch ? `${p.platform}/${p.arch}` : p.platform;
    return w.os === "windows" ? "win" : w.os === "posix" ? "posix" : "?";
  };
  const trunc = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 1) + "…" : s;
  const rows = workers.map((w) => [
    w.id.slice(0, 8),
    trunc(w.name, 28),
    osLabel(w),
    w.connected ? "online" : "offline",
    trunc(w.fsRoot || "", 40),
    trunc(w.user?.name || w.user?.email || "", 24),
    w.shared ? "yes" : "-",
    w.cloudWorkerId ? "cloud" : "-",
    relativeTime(w.lastConnected),
  ]);
  const header = [
    "ID",
    "NAME",
    "OS",
    "STATUS",
    "ROOT",
    "OWNER",
    "SHARED",
    "CLOUD",
    "SEEN",
  ];
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all
    .map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}
