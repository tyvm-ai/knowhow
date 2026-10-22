import * as path from "path";
import { HostClient } from "./HostClient";
import { ensureHost, hostBinaryPath, parseSingleInstance, probeHost } from "./hostLauncher";
import type { ApprovalInfo, AuditEntry, ControlRequest, ControlResults, RunArgs, WorkerInfo } from "./protocol";
import { loadAutomation } from "../automation";

/** Native dialogs (approve / re-arm) wait for a human: allow them to. */
const HUMAN_TIMEOUT_MS = 150_000;

/** True when a host binary exists or a host is already running. */
export async function hostAvailable(): Promise<boolean> {
  return !!hostBinaryPath() || !!(await probeHost());
}

/** Run one control request on a short-lived connection. */
export async function hostRequest<T extends ControlRequest["type"]>(
  msg: Extract<ControlRequest, { type: T }>,
  timeoutMs?: number
): Promise<ControlResults[T]> {
  const c = await HostClient.connect("control");
  try {
    return (await c.request(msg, timeoutMs)) as ControlResults[T];
  } finally {
    c.close();
  }
}

/** Live workers, or [] if no host is running (never spawns a host). */
export async function listWorkers(): Promise<WorkerInfo[]> {
  if (!(await probeHost())) return [];
  return (await hostRequest({ type: "list" })).workers;
}

export interface StartOptions {
  cwd?: string;
  params?: string;
  maxMs?: string | number;
  dryRun?: boolean;
  singleInstance?: "replace" | "ignore" | "allow";
}

/**
 * Start an automation as a host-managed worker (spawns the host if needed).
 *
 * The client only names the file and structured args; it can NOT pick a
 * command. The host resolves + hashes the file, checks its approval store (a
 * native dialog appears if the script is new or changed — this call waits for
 * the human) and spawns the node runner itself. Saved automations are resolved
 * to their file path here.
 */
export async function startAutomation(name: string, opts: StartOptions = {}) {
  const spec = loadAutomation(name); // fail early if missing
  if (!spec.filePath || !/\.(?:ts|js|mts|cts|khs)$/i.test(spec.filePath)) {
    throw new Error(`"${name}" is not a script file the host can approve (${spec.filePath ?? "no file"}).`);
  }
  const cwd = opts.cwd ?? process.cwd();
  await ensureHost();
  const args: RunArgs = {};
  if (opts.params) {
    const p = JSON.parse(opts.params);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("--params-json must be a JSON object");
    args.params = p;
  }
  if (opts.maxMs !== undefined) args.maxDurationMs = Number(opts.maxMs);
  if (opts.dryRun) args.dryRun = true;
  return hostRequest(
    {
      type: "start",
      // absolute: the host's cwd differs from ours
      automationPath: path.resolve(spec.filePath),
      name: spec.name,
      args,
      cwd,
      singleInstance: opts.singleInstance ?? parseSingleInstance(spec.script),
    },
    HUMAN_TIMEOUT_MS
  );
}

/** Resolve a saved-automation name or a path to the file the host should approve. */
function approvalPath(nameOrPath: string): string {
  const spec = loadAutomation(nameOrPath);
  if (!spec.filePath) throw new Error(`"${nameOrPath}" has no file to approve.`);
  return path.resolve(spec.filePath);
}

/** Persistently approve an automation path (native dialog unless it is already approved). */
export async function approveAutomation(nameOrPath: string) {
  await ensureHost();
  return hostRequest({ type: "approve", automationPath: approvalPath(nameOrPath) }, HUMAN_TIMEOUT_MS);
}

export async function listApprovals(): Promise<ApprovalInfo[]> {
  if (!(await probeHost())) return [];
  return (await hostRequest({ type: "approvals" })).approvals;
}

/** Tail of the host's append-only audit log (oldest first). */
export async function auditLog(limit = 50): Promise<AuditEntry[]> {
  if (!(await probeHost())) return [];
  return (await hostRequest({ type: "audit", limit })).entries;
}

/** One human-readable line for an audit entry. */
export function formatAuditEntry(e: AuditEntry): string {
  const parts = [new Date(e.ts).toISOString(), e.event.padEnd(7)];
  if (e.kind) parts.push(`[${e.kind}]`);
  if (e.path) parts.push(e.path);
  if (e.workerId) parts.push(`worker=${e.workerId}${e.pid ? `/pid ${e.pid}` : ""}`);
  if (e.code !== undefined && e.code !== null) parts.push(`code=${e.code}`);
  if (e.sha256) parts.push(`sha256=${e.sha256.slice(0, 12)}`);
  if (e.detail) parts.push(`(${e.detail})`);
  return parts.join("  ");
}

/** Revoke one approval (name/path) or all of them. */
export async function revokeApproval(sel: { nameOrPath?: string; all?: boolean }) {
  await ensureHost();
  let automationPath: string | undefined;
  if (sel.nameOrPath) {
    // The file may be gone (that is a fine reason to revoke): fall back to the literal path.
    try {
      automationPath = approvalPath(sel.nameOrPath);
    } catch {
      automationPath = sel.nameOrPath;
    }
  }
  return hostRequest({ type: "revoke", automationPath, all: sel.all });
}

/** Ask the host to clear the kill-switch latch (the human must confirm in a native dialog). */
export async function rearmKillSwitch() {
  if (!(await probeHost())) return { rearmed: true, halted: false };
  return hostRequest({ type: "rearm" }, HUMAN_TIMEOUT_MS);
}

export async function stopAutomations(sel: { name?: string; all?: boolean; id?: string }) {
  if (!(await probeHost())) return { stopped: [] as string[] };
  return hostRequest({ type: "stop", ...sel });
}

export async function pauseAutomations(sel: { name?: string; all?: boolean; id?: string }) {
  return hostRequest({ type: "pause", ...sel });
}

export async function resumeAutomations(sel: { name?: string; all?: boolean; id?: string }) {
  return hostRequest({ type: "resume", ...sel });
}

export async function restartAutomation(name: string) {
  return hostRequest({ type: "restart", name }, HUMAN_TIMEOUT_MS);
}

/** Is `name` currently a live host-managed worker? */
export async function isHostManaged(name: string): Promise<boolean> {
  return (await listWorkers()).some((w) => w.name === name && w.status !== "exited");
}
