/**
 * ScriptRunStore — the on-disk side of script runs.
 *
 *   <root>/<runId>/state.json    ProcessDocument<ScriptRunState> (owner writes)
 *   <root>/<runId>/control.json  pause / resume / cancel (anyone writes)
 *   <root>/<runId>/input.txt     messages for the script (anyone appends)
 *   <root>/<runId>/script.js     the source, needed to resume
 *
 * <root> defaults to `.knowhow/processes/scripts` (honours
 * KNOWHOW_PROCESSES_DIR like the rest of `.knowhow/processes`).
 */

import * as fs from "fs";
import * as path from "path";
import { FsProcessChannel, ProcessDocument } from "@tyvm/knowhow/sdk";
import {
  ScriptControl,
  ScriptRunRecord,
  ScriptRunState,
  ScriptRunStatus,
  isTerminalScriptStatus,
} from "./ScriptRun";

export function defaultScriptRunsDir(cwd = process.cwd()): string {
  const processes = process.env.KNOWHOW_PROCESSES_DIR || path.join(cwd, ".knowhow", "processes");
  return path.join(processes, "scripts");
}

export function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** A run read from disk (possibly owned by another process, or by nobody). */
export interface PersistedScriptRun extends ScriptRunRecord {
  dir: string;
  /** pid of the process that owns (owned) the run */
  ownerPid?: number;
  /** non-terminal, but its owner process is gone: resume it to continue */
  orphaned: boolean;
  /** control the owner has not applied yet, e.g. "paused" while pausing */
  desired?: string;
  document: ProcessDocument<ScriptRunState, ScriptControl>;
}

export function recordFromDocument(
  doc: ProcessDocument<ScriptRunState, ScriptControl>,
  dir: string
): PersistedScriptRun {
  const s = doc.state;
  const ownerPid = doc.lifecycle.executor?.pid;
  let status: ScriptRunStatus = s.status;
  if (doc.lifecycle.status === "paused" && !isTerminalScriptStatus(status)) status = "paused";
  const orphaned =
    !isTerminalScriptStatus(status) &&
    (ownerPid === undefined ? s.status !== "starting" : !pidAlive(ownerPid));
  return {
    runId: s.runId,
    name: s.name,
    status,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    ownerTaskId: s.ownerTaskId,
    childPid: s.childPid,
    result: s.result,
    error: s.error,
    events: s.events ?? [],
    nextEventSequence: s.nextEventSequence ?? 0,
    droppedEventCount: s.droppedEventCount ?? 0,
    scriptState: s.scriptState ?? {},
    resumeCount: s.resumeCount ?? 0,
    dir,
    ownerPid,
    orphaned,
    desired: doc.control?.desired,
    document: doc,
  };
}

export class ScriptRunStore {
  constructor(readonly root: string = defaultScriptRunsDir()) {}

  dir(runId: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
    return path.join(this.root, runId);
  }

  channel(runId: string): FsProcessChannel<ScriptRunState, ScriptControl> {
    return new FsProcessChannel<ScriptRunState, ScriptControl>(this.dir(runId));
  }

  sourcePath(runId: string): string {
    return path.join(this.dir(runId), "script.js");
  }

  writeSource(runId: string, script: string): void {
    fs.mkdirSync(this.dir(runId), { recursive: true });
    fs.writeFileSync(this.sourcePath(runId), script, "utf8");
  }

  readSource(runId: string): string {
    return fs.readFileSync(this.sourcePath(runId), "utf8");
  }

  read(runId: string): PersistedScriptRun | undefined {
    const file = path.join(this.dir(runId), "state.json");
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!doc?.state?.runId) return undefined;
      return recordFromDocument(doc, this.dir(runId));
    } catch {
      return undefined;
    }
  }

  list(): PersistedScriptRun[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        const run = this.read(e.name);
        return run ? [run] : [];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Accepts an exact id or a unique substring. */
  resolve(idOrPart: string): PersistedScriptRun {
    const exact = this.read(idOrPart);
    if (exact) return exact;
    const matches = this.list().filter((r) => r.runId.includes(idOrPart));
    if (!matches.length) throw new Error(`Script run '${idOrPart}' not found`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous run id '${idOrPart}': ${matches.map((r) => r.runId).join(", ")}`);
    }
    return matches[0];
  }
}
