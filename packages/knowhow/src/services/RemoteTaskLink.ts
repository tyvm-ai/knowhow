import * as fs from "fs";
import * as path from "path";
import { KnowhowSimpleClient } from "./KnowhowClient";
import { withRetry } from "../clients/withRetry";

export interface CreateRemoteTaskParams {
  /** Raw user prompt (used as the remote message content / session title). */
  prompt: string;
  agentName?: string;
  model?: string;
  /** Worker this task runs on (shown in the web UI). */
  workerId?: string;
  /** Existing remote session to add the message to (otherwise a new one is created). */
  sessionId?: string;
  /** Session title (default: first 80 chars of the prompt). */
  title?: string;
  source?: string;
  client?: KnowhowSimpleClient;
}

const REMOTE_UUID_RE =
  /^(remote:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The remote task UUID a parent agent is synced to, if any. Handles
 * `remote:<uuid>` / bare UUID parents (remote parents) and local task ids
 * whose metadata.json carries a remote link.
 */
export function resolveParentRemoteTaskId(
  parentTaskId: string | undefined,
  baseDir: string = localAgentsDir()
): string | undefined {
  if (!parentTaskId) return undefined;
  const linked = readLocalRemoteTaskId(parentTaskId, baseDir);
  if (linked) return linked;
  if (REMOTE_UUID_RE.test(parentTaskId)) {
    return parentTaskId.replace(/^remote:/i, "");
  }
  return undefined;
}

/**
 * Whether a spawned agent should sync itself to the backend automatically:
 * the config has `syncRemote: true` (/sync:remote:on), the caller didn't opt
 * out (`syncRemote: false`), and the parent that spawned it is itself synced
 * to a remote task. Once remote sync is on, every subagent of a synced agent
 * is synced too (transitively, since each child persists its own link).
 */
export function shouldInheritRemoteSync(opts: {
  syncRemote?: boolean;
  parentTaskId?: string;
  configSyncRemote?: boolean;
  baseDir?: string;
}): boolean {
  if (opts.syncRemote !== undefined) return opts.syncRemote;
  if (opts.configSyncRemote !== true) return false;
  return !!resolveParentRemoteTaskId(opts.parentTaskId, opts.baseDir);
}

/** Read `syncRemote` from .knowhow/knowhow.json without throwing. */
export function readConfigSyncRemote(cwd: string = process.cwd()): boolean {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(cwd, ".knowhow", "knowhow.json"), "utf8")
    );
    return cfg?.syncRemote === true;
  } catch {
    return false;
  }
}

export interface RemoteTaskLink {
  sessionId: string;
  messageId: string;
  taskId: string;
}

/**
 * Create the remote half of an agent task: a session placeholder + a message
 * placeholder (which carries the remote task stub). Shared by
 * RemoteWorkers.startRemoteAgentTask, RemoteSyncModule and the runtime
 * `/sync:remote` attach so every path creates remote tasks the same way.
 */
export async function createRemoteTaskForAgent(
  params: CreateRemoteTaskParams
): Promise<RemoteTaskLink> {
  const client = params.client ?? new KnowhowSimpleClient();
  const source = params.source ?? "cli";
  const prompt = params.prompt || "";

  let sessionId = params.sessionId;
  if (!sessionId) {
    const session = await withRetry(
      () =>
        client.createSessionPlaceholder({
          title: (params.title ?? prompt).slice(0, 80) || "CLI Session",
          workerId: params.workerId,
          metadata: { source, createdAt: new Date().toISOString() },
        } as any),
      { maxRetries: 3, backoffMs: 500 }
    );
    sessionId = session.sessionId;
  }

  const msg = await withRetry(
    () =>
      client.createMessagePlaceholder(sessionId!, {
        content: prompt,
        agentName: params.agentName,
        modelName: params.model,
        metadata: {
          source,
          ...(params.workerId ? { worker: params.workerId } : {}),
          createdAt: new Date().toISOString(),
        },
      } as any),
    { maxRetries: 3, backoffMs: 500 }
  );
  if (!msg.taskId) {
    throw new Error(
      "Backend did not return a taskId for the remote message placeholder"
    );
  }
  return { sessionId: sessionId!, messageId: msg.messageId, taskId: msg.taskId };
}

/** Local agents directory (resolved lazily so tests/cwd changes are respected). */
export function localAgentsDir(): string {
  return path.join(process.cwd(), ".knowhow", "processes", "agents");
}

/** Read the remote task UUID a local task is linked to (metadata.json), if any. */
export function readLocalRemoteTaskId(
  taskId: string | undefined,
  baseDir: string = localAgentsDir()
): string | undefined {
  if (!taskId) return undefined;
  try {
    const metaPath = path.join(baseDir, taskId, "metadata.json");
    if (!fs.existsSync(metaPath)) return undefined;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return meta.remoteTaskId || meta.knowhowTaskId || undefined;
  } catch {
    return undefined;
  }
}

/** Poll metadata.json until the task is linked to a remote task (or timeout). */
export async function waitForLocalRemoteTaskId(
  taskId: string,
  opts: { timeoutMs?: number; pollMs?: number; baseDir?: string } = {}
): Promise<string | undefined> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const pollMs = opts.pollMs ?? 250;
  for (;;) {
    const id = readLocalRemoteTaskId(taskId, opts.baseDir);
    if (id) return id;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
