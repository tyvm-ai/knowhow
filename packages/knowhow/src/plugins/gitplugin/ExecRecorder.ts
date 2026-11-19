import * as fs from "fs";
import * as path from "path";
import { Policy } from "./Policy";
import { Recorder } from "./Recorder";
import { Sweeper } from "./Sweeper";
import { BULK_PATH_CAP } from "./types";

interface Inflight {
  execId: string;
  taskId: string;
  cmd: string;
  startMs: number;
  /** other execs that were running at any time during this one */
  overlap: Set<string>;
  /** edit counter value (other agents' edits) when this exec started */
  editsAtStart: number;
}

/**
 * Records files changed by shell commands (design §3). Pre-run: isolating sweep
 * when nothing else is running. Done: dirty paths vs the timeline become one
 * `exec` commit; ambiguous when execs/edits of other agents overlapped.
 */
export class ExecRecorder {
  private inflight = new Map<string, Inflight>();
  private edits: { n: number; byAgent: Map<string, number> } = { n: 0, byAgent: new Map() };
  private registry: string;

  constructor(
    private gitDir: string,
    private recorder: Recorder,
    private sweeper: Sweeper,
    private policy: Policy,
    private realHead: () => string | undefined,
    private log: (m: string, level?: "info" | "warn" | "error") => void
  ) {
    this.registry = path.join(gitDir, "inflight");
  }

  noteEdit(agent: string) {
    this.edits.n++;
    this.edits.byAgent.set(agent, (this.edits.byAgent.get(agent) || 0) + 1);
  }

  private othersEdits(agent: string): number {
    return this.edits.n - (this.edits.byAgent.get(agent) || 0);
  }

  /** In-flight execs in other CLI processes (registry files whose pid is alive). */
  private foreignInflight(): { execId: string; taskId: string }[] {
    const out: { execId: string; taskId: string }[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.registry);
    } catch {
      return out;
    }
    for (const n of names) {
      const f = path.join(this.registry, n);
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        if (j.pid === process.pid) continue;
        let alive = true;
        try {
          process.kill(j.pid, 0);
        } catch (e: any) {
          alive = e?.code === "EPERM";
        }
        if (!alive || Date.now() - j.startMs > 6 * 3600_000) {
          fs.rmSync(f, { force: true });
          continue;
        }
        out.push({ execId: j.execId, taskId: j.taskId });
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  private register(e: Inflight) {
    try {
      fs.mkdirSync(this.registry, { recursive: true });
      fs.writeFileSync(
        path.join(this.registry, `${e.execId}.json`),
        JSON.stringify({ execId: e.execId, taskId: e.taskId, pid: process.pid, startMs: e.startMs })
      );
    } catch {
      /* best effort */
    }
  }

  private unregister(execId: string) {
    this.inflight.delete(execId);
    try {
      fs.rmSync(path.join(this.registry, `${execId}.json`), { force: true });
    } catch {
      /* ignore */
    }
  }

  /** exec:pre-run (foreground and background launches alike). */
  onPreRun(data: any) {
    const execId: string = data?.execId || `anon-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const taskId: string = data?.taskId || "unknown";
    const others = [
      ...Array.from(this.inflight.values()).map((i) => i.execId),
      ...this.foreignInflight().map((i) => i.execId),
    ];
    if (!others.length) {
      try {
        this.sweeper.sweep({ summary: `before exec: ${String(data?.command || "").slice(0, 80)}`, waitMs: 1000 });
      } catch (e) {
        this.log(`pre-run sweep failed: ${e}`, "warn");
      }
    }
    for (const i of this.inflight.values()) i.overlap.add(execId);
    const entry: Inflight = {
      execId,
      taskId,
      cmd: String(data?.command || ""),
      startMs: Date.now(),
      overlap: new Set(others),
      editsAtStart: this.othersEdits(taskId),
    };
    this.inflight.set(execId, entry);
    this.register(entry);
    if (data && !data.execId) data.execId = execId;
  }

  /** tool:execCommand:done. Returns the recorded sha (if any). */
  onDone(data: any): { sha: string | null; files: string[] } | null {
    const execId: string | undefined = data?.execId;
    const taskId: string = data?.taskId || "unknown";
    const entry = execId ? this.inflight.get(execId) : undefined;
    if (execId) this.unregister(execId);
    if (data?.background) return null; // unknowable end; the next sweep picks effects up
    const cmd = String(data?.command || entry?.cmd || "");
    const dirty = this.sweeper.dirtyPaths(2000);
    if (dirty === null) {
      this.log("exec recording skipped: could not read dirty paths in time", "warn");
      return null;
    }
    if (!dirty.length) return null;
    const f = this.policy.filter(dirty);
    if (f.skippedOversize.length) {
      this.log(`exec recording: skipped ${f.skippedOversize.length} file(s) over ${Math.round(this.policy.maxBytes / 1048576)} MB`, "warn");
    }
    if (!f.keep.length) return null;

    const also = new Set<string>();
    if (entry) {
      for (const id of entry.overlap) also.add(this.taskOf(id));
    }
    const foreign = this.foreignInflight();
    for (const x of foreign) also.add(x.taskId);
    const otherEdit = entry ? this.othersEdits(taskId) > entry.editsAtStart : false;
    if (otherEdit) {
      for (const [a, n] of this.edits.byAgent) if (a !== taskId && n > 0) also.add(a);
    }
    const ambiguous = (entry ? entry.overlap.size > 0 : false) || foreign.length > 0 || otherEdit;
    also.delete(taskId);
    const bulk = f.keep.length > BULK_PATH_CAP;
    const r = this.recorder.recordChange({
      agent: taskId,
      kind: "exec",
      tool: "execCommand",
      cmd,
      summary: bulk ? `${cmd.slice(0, 120)} (${f.keep.length} files)` : `${cmd.slice(0, 120)}`,
      paths: f.keep,
      attribution: ambiguous ? "ambiguous" : "exact",
      alsoPossible: ambiguous ? Array.from(also) : undefined,
      realHead: this.realHead(),
      bulk,
    });
    return { sha: r.sha, files: r.files };
  }

  private taskOf(execId: string): string {
    const e = this.inflight.get(execId);
    if (e) return e.taskId;
    return execId;
  }
}
