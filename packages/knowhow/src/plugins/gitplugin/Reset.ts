import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import { Recorder } from "./Recorder";
import { Sweeper } from "./Sweeper";
import { withLock } from "./Lock";
import { TASK_REF_PREFIX, TIMELINE_REF } from "./types";

export interface ResetOptions {
  dropLegacy?: boolean;
  apply?: boolean;
  force?: boolean;
  /** refuse --drop-legacy when a legacy ref changed within this many minutes (a V1 process may be alive) */
  minutes?: number;
  /** prune unreferenced objects of any age (default keeps the last 10 minutes: an agent may be mid-record) */
  pruneNow?: boolean;
  /** start the final gc in the background instead of waiting for it (automatic maintenance) */
  gcDetached?: boolean;
}

export interface ResetReport {
  applied: boolean;
  refused?: string;
  timelineBefore: string | null;
  timelineAfter: string | null;
  commitsBefore: number;
  legacyRefs: string[];
  droppedLegacy: string[];
  sizeBeforeKB: number;
  sizeAfterKB: number;
  files: number;
}

export function dirSizeKB(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else total += fs.statSync(f).blocks * 512;
      } catch { /* vanished */ }
    }
  };
  walk(dir);
  return Math.round(total / 1024);
}

/**
 * `history reset [--drop-legacy]`: re-root `timeline` to ONE commit of its current tree (the work tree
 * is not read or written; a sweep first makes the tip equal the work tree). With drop-legacy also delete
 * main and task/* (refusing when one changed recently: a V1 process may be alive) and the old task
 * markers, then expire reflogs and gc. Never touches HEAD, the default index or the work tree.
 */
export function resetHistory(
  git: GitRunner,
  recorder: Recorder,
  sweeper: Sweeper,
  opts: ResetOptions = {}
): ResetReport {
  const rep: ResetReport = {
    applied: false, timelineBefore: recorder.tip(), timelineAfter: null, commitsBefore: 0, legacyRefs: [], droppedLegacy: [],
    sizeBeforeKB: dirSizeKB(git.gitDir), sizeAfterKB: 0, files: 0,
  };
  rep.commitsBefore = Number(git.tryRun(["rev-list", "--count", TIMELINE_REF]) || 0);
  const refs = (git.tryRun(["for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/heads/main", "refs/heads/task/"]) || "")
    .split("\n").filter(Boolean).map((l) => l.trim().split(" "));
  rep.legacyRefs = refs.map(([r]) => r);
  rep.sizeAfterKB = rep.sizeBeforeKB;
  rep.files = Number(git.tryRun(["ls-tree", "-r", "--name-only", TIMELINE_REF])?.split("\n").filter(Boolean).length || 0);

  if (opts.dropLegacy && !opts.force) {
    const minutes = opts.minutes ?? 30;
    const recent = refs.filter(([, t]) => Date.now() - Number(t) * 1000 < minutes * 60_000).map(([r]) => r);
    if (recent.length) {
      rep.refused = `legacy ref(s) updated within ${minutes} min (${recent.slice(0, 3).join(", ")}): a V1 process may be running. Use --force to override.`;
      return rep;
    }
    for (const f of ["index.lock", "MERGE_HEAD"]) {
      if (fs.existsSync(path.join(git.gitDir, f))) {
        rep.refused = `${f} exists: a V1 process may be mid-operation. Use --force to override.`;
        return rep;
      }
    }
  }
  if (!opts.apply) return rep;

  const lock = path.join(git.gitDir, "reset.lock");
  const done = withLock(lock, 5000, () => {
    sweeper.sweep({ summary: "before reset", waitMs: 5000 });
    const tip = recorder.tip();
    if (!tip) throw new Error("no timeline to reset");
    const tree = git.run(["rev-parse", `${tip}^{tree}`]);
    const msg = `[system] marker: timeline reset\n\nAgent: system\nKind: marker\nReset-From: ${tip}\nReset-Commits: ${rep.commitsBefore}`;
    const root = git.run(["commit-tree", tree, "-m", msg]);
    // CAS: if someone recorded in between, refuse rather than drop their commit
    const ok = git.tryRun(["update-ref", "-m", "knowhow: history reset", TIMELINE_REF, root, tip]);
    if (ok === null) throw new Error("timeline moved while resetting; run again");
    rep.timelineAfter = root;
    // task markers point into the old history
    for (const r of (git.tryRun(["for-each-ref", "--format=%(refname)", TASK_REF_PREFIX]) || "").split("\n").filter(Boolean)) {
      git.tryRun(["update-ref", "-d", r]);
    }
    if (opts.dropLegacy) {
      for (const [r] of refs) {
        if (git.tryRun(["update-ref", "-d", r]) !== null) rep.droppedLegacy.push(r);
      }
    }
    // sweep.index.tip refers to the old tip: drop the persistent sweep index
    sweeper.reset();
    for (const n of ["refs/notes/commits"]) {
      if (opts.dropLegacy) git.tryRun(["update-ref", "-d", n]);
    }
    fs.rmSync(path.join(git.gitDir, "logs"), { recursive: true, force: true });
    const gcArgs = ["gc", opts.pruneNow ? "--prune=now" : "--prune=10.minutes.ago", "--quiet"];
    if (opts.gcDetached) git.runDetached(gcArgs);
    else git.tryRun(gcArgs, { timeoutMs: 600_000 });
    rep.applied = true;
    return true;
  });
  if (done === undefined) throw new Error("another reset is running (reset.lock)");
  rep.sizeAfterKB = dirSizeKB(git.gitDir);
  return rep;
}
