import * as fs from "fs";
import * as path from "path";
import { Doctor, DoctorReport } from "./Doctor";
import { ExecRecorder } from "./ExecRecorder";
import { GitRunner } from "./GitRunner";
import { History } from "./History";
import { migrate, MigrationResult, realHeadShort } from "./Migration";
import { IncludeSet } from "./Include";
import { Policy } from "./Policy";
import { Recorder } from "./Recorder";
import { Sweeper, SweepResult } from "./Sweeper";
import { tryLock, unlock } from "./Lock";
import { maintain, MaintainReport } from "./Maintenance";
import { Parts, RestoreOptions, RestoreResult, restoreFile } from "./Restore";
import { ResetOptions, ResetReport, resetHistory } from "./Reset";
import { RevertOptions, RevertReport, revertAgent } from "./Revert";
import { TASK_REF_PREFIX, TIMELINE_REF } from "./types";

export interface CoreOptions {
  root: string;
  maxFileMb?: () => number | undefined;
  /** config gitPlugin.include: ignored paths that stay tracked */
  include?: () => string[] | undefined;
  /** config gitPlugin.autoMaintain (false = no automatic gc / reset) */
  autoMaintain?: () => boolean | undefined;
  /** config gitPlugin.maxRepoMb (default 300) */
  maxRepoMb?: () => number | undefined;
  log?: (m: string, level?: "info" | "warn" | "error") => void;
}

/** All git plugin parts wired together; no event handling here (see GitPlugin). */
export class TimelineCore {
  readonly root: string;
  readonly gitDir: string;
  readonly git: GitRunner;
  readonly policy: Policy;
  readonly recorder: Recorder;
  readonly sweeper: Sweeper;
  readonly history: History;
  readonly doctor: Doctor;
  readonly exec: ExecRecorder;
  private startedAtMs = Date.now();
  private autoMaintain?: () => boolean | undefined;
  private maxRepoMb?: () => number | undefined;
  private log: (m: string, level?: "info" | "warn" | "error") => void;
  private realHeadCache?: { at: number; v: string | undefined };
  migration?: MigrationResult;
  repaired?: string;

  constructor(opts: CoreOptions) {
    this.root = opts.root;
    this.gitDir = path.join(opts.root, ".knowhow", ".git");
    this.log = opts.log || (() => {});
    this.autoMaintain = opts.autoMaintain;
    this.maxRepoMb = opts.maxRepoMb;
    this.git = new GitRunner(this.gitDir, this.root);
    this.policy = new Policy(this.git, this.root, opts.maxFileMb || (() => undefined), new IncludeSet(opts.root, opts.include || (() => undefined)));
    this.recorder = new Recorder(this.git);
    const rh = () => this.realHead();
    this.sweeper = new Sweeper(this.git, this.recorder, this.policy, rh);
    this.history = new History(this.git);
    this.doctor = new Doctor(this.git, this.root);
    this.exec = new ExecRecorder(this.gitDir, this.recorder, this.sweeper, this.policy, rh, this.log);
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.gitDir, "objects"));
  }

  realHead(): string | undefined {
    const now = Date.now();
    if (this.realHeadCache && now - this.realHeadCache.at < 2000) return this.realHeadCache.v;
    const v = realHeadShort(this.root);
    this.realHeadCache = { at: now, v };
    return v;
  }

  /** Migrate/adopt the history repo, run doctor (repair if broken), baseline sweep. */
  start(): { migration: MigrationResult; doctor: DoctorReport; sweep: SweepResult } {
    this.startedAtMs = Date.now();
    let migration = migrate(this.git, this.policy, this.root, this.startedAtMs);
    let report = this.doctor.check();
    let summary = "baseline sweep";
    if (!report.ok) {
      const busy = this.doctor.legacyBusy();
      if (busy) {
        // a V1 process may be using this repo: never move it aside (A1)
        throw new Error(`history repo looks broken (${report.problems.join("; ")}) but a legacy process may be using it (${busy}); not repairing`);
      }
      const lock = path.join(this.gitDir, "..", ".git.repair.lock");
      if (tryLock(lock, 0)) {
        try {
          const backup = this.doctor.moveAside();
          this.repaired = backup;
          this.log(`history repo was broken (${report.problems.join("; ")}); moved to ${backup} and re-created`, "warn");
          this.sweeper.reset();
          migration = migrate(this.git, this.policy, this.root, this.startedAtMs);
          summary = "baseline after repair";
          report = this.doctor.check();
        } finally {
          unlock(lock);
        }
      }
    }
    this.migration = migration;
    const sweep = this.sweeper.sweep({ summary, waitMs: 10_000 });
    if (report.ok) this.runMaintenance();
    return { migration, doctor: report, sweep };
  }

  /** Once-a-day gc --auto and size-triggered reset (see Maintenance.ts); never throws, logs one line. */
  runMaintenance(force = false): MaintainReport | undefined {
    try {
      const r = maintain(this.git, this.recorder, this.sweeper, {
        enabled: this.autoMaintain,
        maxRepoMb: this.maxRepoMb,
        legacyBusy: () => this.doctor.legacyBusy(24 * 60 * 60_000),
        force,
      });
      if (r.ran && r.line) this.log(r.line, r.reset === "none" ? "info" : "warn");
      return r;
    } catch (e) {
      this.log(`git maintenance failed: ${e}`, "warn");
      return undefined;
    }
  }

  private parts(): Parts {
    return { git: this.git, policy: this.policy, recorder: this.recorder, sweeper: this.sweeper, history: this.history, root: this.root, realHead: () => this.realHead() };
  }

  /** `history restore`: the only paths that write the work tree are restore() and revert() with apply (see WorkTreeWriter). */
  restore(pathArg: string, opts: RestoreOptions = {}): RestoreResult {
    return restoreFile(this.parts(), pathArg, opts);
  }

  revert(opts: RevertOptions): RevertReport {
    return revertAgent(this.parts(), opts);
  }

  reset(opts: ResetOptions = {}): ResetReport {
    return resetHistory(this.git, this.recorder, this.sweeper, opts);
  }

  setTaskRef(taskId: string, which: "start" | "end"): void {
    const tip = this.recorder.tip();
    if (!tip) return;
    this.git.tryRun(["update-ref", `${TASK_REF_PREFIX}${taskId}/${which}`, tip]);
  }

  /** Keep the newest `keep` task marker pairs (by start-ref commit date). */
  pruneTaskRefs(keep: number): number {
    const out =
      this.git.tryRun([
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)",
        TASK_REF_PREFIX,
      ]) || "";
    const ids: string[] = [];
    for (const ref of out.split("\n").filter(Boolean)) {
      const m = /^refs\/knowhow\/tasks\/(.+)\/(start|end)$/.exec(ref);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
    const stale = ids.slice(keep);
    for (const id of stale) {
      for (const w of ["start", "end"]) {
        this.git.tryRun(["update-ref", "-d", `${TASK_REF_PREFIX}${id}/${w}`]);
      }
    }
    return stale.length;
  }

  dispose() {
    this.git.dispose();
  }
}

export { TIMELINE_REF };
