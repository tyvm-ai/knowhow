/**
 * Shared read-only index over `.knowhow/processes/agents/<taskId>/` used by
 * both `knowhow agents list` (CLI) and the `listAgents` tool (delegating
 * agents), so an orchestrator sees the same data either way.
 */
import * as fs from "fs";
import * as path from "path";

export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "error",
  "done",
]);
const ACTIVE_STATUSES = new Set(["running", "paused"]);
// Older task records did not persist a pid. After this grace period, report
// them as unverifiable rather than continuing to claim they are running.
const UNVERIFIED_TASK_GRACE_MS = 5 * 60 * 1000;

/** Resolved lazily so tests (and cwd changes) are respected. */
export function defaultAgentsDir(): string {
  return path.join(process.cwd(), ".knowhow", "processes", "agents");
}

export function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but cannot be signalled by this user.
    return error?.code === "EPERM";
  }
}

export function loadAgentMeta(taskId: string, agentsDir = defaultAgentsDir()) {
  return readJson(path.join(agentsDir, taskId, "metadata.json"));
}

function loadStatusFile(taskId: string, agentsDir: string): string {
  try {
    return fs
      .readFileSync(path.join(agentsDir, taskId, "status.txt"), "utf-8")
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * Effective status, reconciling persisted state with process liveness. An agent
 * can be terminated before its AgentSession finalizes its files; those records
 * must not remain "running" forever.
 */
export function getAgentStatus(
  taskId: string,
  meta: any | null,
  agentsDir = defaultAgentsDir()
): string {
  const persisted = meta?.status || loadStatusFile(taskId, agentsDir) || "unknown";
  if (TERMINAL_STATUSES.has(persisted)) return persisted;
  if (meta?.inProgress === false) return "completed";
  if (!ACTIVE_STATUSES.has(persisted)) return persisted;

  const pid = meta?.pid ?? meta?.processId;
  if (typeof pid === "number") {
    return pidAlive(pid) ? persisted : "failed";
  }

  const lastKnownTime = meta?.lastUpdate ?? meta?.startTime;
  const lastKnownMs = lastKnownTime ? new Date(lastKnownTime).getTime() : NaN;
  if (
    !Number.isFinite(lastKnownMs) ||
    Date.now() - lastKnownMs > UNVERIFIED_TASK_GRACE_MS
  ) {
    return "stale";
  }
  return persisted;
}

export function messageText(msg: any): string | undefined {
  if (!msg) return undefined;
  if (typeof msg.content === "string") {
    return msg.content.trim() || undefined;
  }
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

/** Last assistant message text in a thread (flat message array). */
export function lastAssistantMessage(thread: any[]): string | undefined {
  if (!Array.isArray(thread)) return undefined;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i]?.role === "assistant") {
      const text = messageText(thread[i]);
      if (text) return text;
    }
  }
  return undefined;
}

/** Last message text of the newest thread in `meta.threads` (array of arrays). */
export function lastAssistantOfMeta(meta: any | null): string | undefined {
  const threads = meta?.threads;
  if (!Array.isArray(threads) || threads.length === 0) return undefined;
  const thread = Array.isArray(threads[0])
    ? threads[threads.length - 1]
    : threads;
  return lastAssistantMessage(thread);
}

export function oneLine(text: string | undefined, max = 140): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

const REPORT_PATH_RE =
  /((?:~|\.{0,2})\/?(?:[\w@.+-]+\/)*[\w@.+-]*(?:report|output|result|summary)[\w@.+-]*\.(?:md|mdx|json|txt))/i;

/**
 * Best-effort report/output path: explicit metadata first, then an artifact,
 * then a "...-report.md"-looking path mentioned in the final result / last
 * assistant message.
 */
export function findReportPath(
  meta: any | null,
  lastMessage?: string
): string | undefined {
  if (!meta) return undefined;
  if (typeof meta.reportPath === "string" && meta.reportPath) {
    return meta.reportPath;
  }
  if (Array.isArray(meta.artifacts) && meta.artifacts.length > 0) {
    const first = meta.artifacts[0];
    if (typeof first === "string") return first;
    if (first && typeof first.path === "string") return first.path;
  }
  for (const text of [
    typeof meta.result === "string" ? meta.result : undefined,
    lastMessage,
  ]) {
    const m = text ? REPORT_PATH_RE.exec(text) : null;
    if (m) return m[1];
  }
  return undefined;
}

export function formatElapsed(startIso: string | undefined, endIso?: string) {
  if (!startIso) return "?";
  const ms =
    (endIso ? new Date(endIso).getTime() : Date.now()) -
    new Date(startIso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  }
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor(
    (ms % 3_600_000) / 60_000
  )}m`;
}

export interface AgentTaskSummary {
  taskId: string;
  agentName: string;
  status: string;
  parentTaskId?: string;
  costUsd: number | null;
  elapsed: string;
  startTime?: string;
  lastUpdate?: string;
  model?: string;
  /** One-line, truncated last assistant message. */
  lastMessage: string;
  /** Best-effort report/output path. */
  reportPath?: string;
  /** Short prompt preview (what the agent was asked to do). */
  prompt: string;
}

export interface ListAgentTasksOptions {
  /** Include finished/stale tasks older than an hour. */
  all?: boolean;
  agentsDir?: string;
  /** Only tasks with this parent. */
  parentTaskId?: string;
  /** Only tasks with this status. */
  status?: string;
  /** Truncation for lastMessage. */
  lastMessageChars?: number;
}

export function listAgentTaskIds(agentsDir = defaultAgentsDir()): string[] {
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function summarizeAgentTask(
  taskId: string,
  agentsDir = defaultAgentsDir(),
  lastMessageChars = 140
): AgentTaskSummary {
  const meta = loadAgentMeta(taskId, agentsDir);
  const status = getAgentStatus(taskId, meta, agentsDir);
  const finished = TERMINAL_STATUSES.has(status) || status === "stale";
  const lastText = lastAssistantOfMeta(meta);
  return {
    taskId,
    agentName: meta?.agentName ?? "?",
    status,
    ...(meta?.parentTaskId ? { parentTaskId: meta.parentTaskId } : {}),
    costUsd: typeof meta?.totalCostUsd === "number" ? meta.totalCostUsd : null,
    elapsed: formatElapsed(meta?.startTime, finished ? meta?.lastUpdate : undefined),
    startTime: meta?.startTime,
    lastUpdate: meta?.lastUpdate,
    model: meta?.model,
    lastMessage: oneLine(lastText, lastMessageChars),
    reportPath: findReportPath(meta, lastText),
    prompt: oneLine(typeof meta?.prompt === "string" ? meta.prompt : "", 120),
  };
}

/** Task summaries sorted by lastUpdate ascending (same order `agents list` shows). */
export function listAgentTasks(
  opts: ListAgentTasksOptions = {}
): AgentTaskSummary[] {
  const agentsDir = opts.agentsDir ?? defaultAgentsDir();
  const out: AgentTaskSummary[] = [];
  for (const taskId of listAgentTaskIds(agentsDir)) {
    const s = summarizeAgentTask(taskId, agentsDir, opts.lastMessageChars);
    if (
      !opts.all &&
      (TERMINAL_STATUSES.has(s.status) || s.status === "stale")
    ) {
      if (!s.lastUpdate) continue;
      if (Date.now() - new Date(s.lastUpdate).getTime() > 3_600_000) continue;
    }
    if (opts.parentTaskId && s.parentTaskId !== opts.parentTaskId) continue;
    if (opts.status && s.status !== opts.status) continue;
    out.push(s);
  }
  return out;
}
