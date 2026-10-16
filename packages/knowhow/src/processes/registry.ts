/**
 * One listing over every kind of process knowhow persists under
 * `.knowhow/processes/`:
 *
 *   <id>/status.json                    exec'd managed processes  (kind "exec")
 *   agents/<taskId>/metadata.json       agent tasks               (kind "agent")
 *   <dir>/<id>/state.json               any StatefulProcess using an
 *                                       FsProcessChannel, e.g. scripts/<runId>
 *                                       (kind = meta.kind, e.g. "script")
 *
 * Plus the control surface they share: pause / resume / cancel / send.
 * Without `all`, only processes that are not finished are listed.
 * Specialised commands (`knowhow agents`, `knowhow scripts`) stay the rich
 * views; this is the "what is running here?" view.
 */

import * as fs from "fs";
import * as path from "path";
import { getProcessesDir, listManagedProcesses, ManagedProcess } from "./ProcessManager";
import { AgentFsChannel } from "../services/stateful/agent/AgentFsChannel";
import { FsProcessChannel } from "../services/stateful/channels/JsonFileChannel";
import type { ProcessDocument } from "../services/stateful/types";
import { isTerminalStatus } from "../services/stateful/types";

export type ProcessSource = "exec" | "agent" | "stateful";

export interface ProcessEntry {
  id: string;
  kind: string;
  source: ProcessSource;
  name?: string;
  status: string;
  terminal: boolean;
  pid?: number | null;
  parentId?: string | null;
  startedAt?: string;
  updatedAt?: string;
  dir: string;
  /** one-line description (command, prompt, script name) */
  summary: string;
}

const EXEC_TERMINAL = new Set(["exited", "failed", "stopped"]);
const AGENT_TERMINAL = new Set(["completed", "failed", "killed", "error", "done", "cancelled", "stale"]);

export function pidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function execEntries(root: string): ProcessEntry[] {
  return listManagedProcesses(root).map(({ id, directory, status }) => ({
    id,
    kind: "exec",
    source: "exec" as const,
    status: status.state,
    terminal: EXEC_TERMINAL.has(status.state),
    pid: status.pid,
    parentId: status.parentProcessId,
    startedAt: status.startedAt,
    updatedAt: status.endedAt ?? status.startedAt,
    dir: directory,
    summary: [status.command, ...status.args].join(" "),
  }));
}

function agentEntries(root: string): ProcessEntry[] {
  const dir = path.join(root, "agents");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (!e.isDirectory()) return [];
    const taskDir = path.join(dir, e.name);
    const meta = readJson(path.join(taskDir, "metadata.json"));
    if (!meta) return [];
    let status: string = meta.status || "unknown";
    try {
      status = fs.readFileSync(path.join(taskDir, "status.txt"), "utf8").trim() || status;
    } catch { /* metadata only */ }
    if (meta.inProgress === false && !AGENT_TERMINAL.has(status)) status = "completed";
    const pid = meta.pid ?? meta.processId;
    if (status === "running" || status === "paused") {
      // same reconciliation as `knowhow agents`: dead pid, or no pid and silent > 5 min
      if (typeof pid === "number") {
        if (!pidAlive(pid)) status = "orphaned";
      } else {
        const last = new Date(meta.lastUpdate ?? meta.startTime ?? 0).getTime();
        if (!Number.isFinite(last) || Date.now() - last > 5 * 60 * 1000) status = "stale";
      }
    }
    const firstUser = Array.isArray(meta.threads?.[0])
      ? meta.threads[0].find((m: any) => m?.role === "user" && typeof m.content === "string")
      : undefined;
    let prompt: string = typeof meta.initialInput === "string" ? meta.initialInput
      : typeof meta.prompt === "string" ? meta.prompt : firstUser?.content ?? "";
    // chat input wrapped with plugin context: show just the task
    const task = prompt.match(/<CurrentTask>([\s\S]*?)<\/CurrentTask>/);
    if (task) prompt = task[1].trim();
    return [{
      id: e.name,
      kind: "agent",
      source: "agent" as const,
      name: meta.agentName,
      status,
      terminal: AGENT_TERMINAL.has(status) || status === "orphaned",
      pid: typeof pid === "number" ? pid : null,
      parentId: meta.parentTaskId ?? null,
      startedAt: meta.startTime,
      updatedAt: meta.lastUpdate,
      dir: taskDir,
      summary: `${meta.agentName ?? "agent"}: ${prompt.replace(/\s+/g, " ").slice(0, 200)}`,
    }];
  });
}

/** `<root>/<group>/<id>/state.json` documents written by FsProcessChannel. */
function statefulEntries(root: string): ProcessEntry[] {
  if (!fs.existsSync(root)) return [];
  const out: ProcessEntry[] = [];
  for (const group of fs.readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name === "agents") continue;
    const groupDir = path.join(root, group.name);
    if (fs.existsSync(path.join(groupDir, "status.json"))) continue; // an exec process
    for (const e of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(groupDir, e.name);
      const doc = readJson(path.join(dir, "state.json")) as ProcessDocument | undefined;
      if (!doc?.meta || !doc.lifecycle) continue;
      let status: string = doc.lifecycle.status;
      // kind-specific statuses (e.g. a script's "timedOut") live in state.status
      const own = (doc.state as any)?.status;
      if (typeof own === "string" && isTerminalStatus(doc.lifecycle.status)) status = own;
      const pid = doc.lifecycle.executor?.pid;
      const terminal = isTerminalStatus(doc.lifecycle.status);
      if (!terminal && pid !== undefined && !pidAlive(pid)) status = "orphaned";
      else if (!terminal && doc.control?.desired === "paused" && status === "running") status = "pausing";
      out.push({
        id: doc.meta.id,
        kind: doc.meta.kind,
        source: "stateful",
        name: doc.meta.name,
        status,
        terminal: terminal || status === "orphaned",
        pid: pid ?? null,
        parentId: doc.meta.parentId ?? null,
        startedAt: doc.lifecycle.startedAt ?? doc.meta.createdAt,
        updatedAt: doc.lifecycle.updatedAt,
        dir,
        summary: `${doc.meta.kind}${doc.meta.name ? `: ${doc.meta.name}` : ""}`,
      });
    }
  }
  return out;
}

export function listAllProcesses(
  opts: { root?: string; all?: boolean; kinds?: string[] } = {}
): ProcessEntry[] {
  const root = opts.root ?? getProcessesDir();
  let entries = [...execEntries(root), ...agentEntries(root), ...statefulEntries(root)];
  if (opts.kinds?.length) entries = entries.filter((e) => opts.kinds!.includes(e.kind));
  if (!opts.all) entries = entries.filter((e) => !e.terminal);
  const when = (e: ProcessEntry) => e.startedAt ?? e.updatedAt ?? "";
  return entries.sort((a, b) => when(b).localeCompare(when(a)));
}

export function resolveProcessEntry(idOrPart: string, opts: { root?: string } = {}): ProcessEntry {
  const all = listAllProcesses({ root: opts.root, all: true });
  const exact = all.find((e) => e.id === idOrPart);
  if (exact) return exact;
  const matches = all.filter((e) => e.id.includes(idOrPart));
  if (!matches.length) throw new Error(`Process not found: ${idOrPart}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous process id '${idOrPart}': ${matches.map((m) => m.id).join(", ")}`);
  }
  return matches[0];
}

/** Pause / resume / cancel any listed process. */
export async function controlProcess(
  entry: ProcessEntry,
  desired: "paused" | "running" | "cancelled"
): Promise<void> {
  if (entry.source === "exec") {
    const signal = desired === "paused" ? "SIGSTOP" : desired === "running" ? "SIGCONT" : "SIGTERM";
    new ManagedProcess(entry.id, entry.dir).signal(signal);
    return;
  }
  if (entry.terminal) throw new Error(`${entry.kind} ${entry.id} is ${entry.status}`);
  const target = entry.source === "agent"
    ? new AgentFsChannel({ taskId: entry.id, baseDir: path.dirname(entry.dir) })
    : new FsProcessChannel(entry.dir);
  await target.writeControl({ desired });
}

/** Send input: stdin for exec processes, input.txt for agents and stateful processes. */
export async function sendToProcess(entry: ProcessEntry, text: string): Promise<void> {
  if (entry.source === "exec") {
    await new ManagedProcess(entry.id, entry.dir).write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  const target = entry.source === "agent"
    ? new AgentFsChannel({ taskId: entry.id, baseDir: path.dirname(entry.dir) })
    : new FsProcessChannel(entry.dir);
  await target.appendInput({ text });
}
