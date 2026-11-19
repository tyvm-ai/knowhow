import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import { Recorder } from "./Recorder";
import { Sweeper } from "./Sweeper";
import { tryLock, unlock } from "./Lock";
import { resetHistory } from "./Reset";

export const DEFAULT_MAX_REPO_MB = 300;
const DAY = 24 * 60 * 60 * 1000;

export interface MaintainOptions {
  /** config gitPlugin.autoMaintain; false turns everything off */
  enabled?: () => boolean | undefined;
  /** config gitPlugin.maxRepoMb (default 300) */
  maxRepoMb?: () => number | undefined;
  /** legacy (V1) busy state, from Doctor.legacyBusy: lock / merge in progress */
  legacyBusy: () => string | null;
  /** run even when the stamp is fresh (tests, `history maintain`) */
  force?: boolean;
}

export interface MaintainReport {
  ran: boolean;
  reason?: string;
  gcStarted: boolean;
  repoMb: number;
  reset: "none" | "timeline" | "timeline+legacy" | "refused";
  line: string;
}

/** Size of the history repo in MB from `count-objects -v` (a few ms, no directory walk). */
export function repoSizeMb(git: GitRunner): number {
  const out = git.tryRun(["count-objects", "-v"]) || "";
  let kb = 0;
  for (const l of out.split("\n")) {
    const m = /^(size|size-pack|size-garbage):\s*(\d+)/.exec(l.trim());
    if (m) kb += Number(m[2]);
  }
  return kb / 1024;
}

/**
 * Conservative automatic maintenance (at most once a day per project, stamp inside .knowhow/.git):
 *  1. `gc --auto` detached (never waited for)
 *  2. when the repo is over maxRepoMb: re-root the timeline (same guards as `history reset`);
 *     `--drop-legacy` only when no main/task/* ref changed in the last 24 h and no lock/merge state exists.
 * Never prunes with --prune-now. Never touches HEAD, the default index or the work tree.
 */
export function maintain(git: GitRunner, recorder: Recorder, sweeper: Sweeper, opts: MaintainOptions): MaintainReport {
  const rep: MaintainReport = { ran: false, gcStarted: false, repoMb: 0, reset: "none", line: "" };
  if (opts.enabled?.() === false) {
    rep.reason = "autoMaintain is off";
    return rep;
  }
  const lock = path.join(git.gitDir, "maintain.lock");
  const stamp = path.join(git.gitDir, "knowhow-maintain.stamp");
  if (!tryLock(lock, 0)) {
    rep.reason = "another process is maintaining";
    return rep;
  }
  try {
    if (!opts.force) {
      try {
        if (Date.now() - fs.statSync(stamp).mtimeMs < DAY) {
          rep.reason = "done within the last day";
          return rep;
        }
      } catch {
        /* no stamp yet */
      }
    }
    // claim the day first: a crash or a slow step must not make every start retry
    try {
      fs.writeFileSync(stamp, new Date().toISOString() + "\n");
    } catch {
      rep.reason = "cannot write stamp";
      return rep;
    }
    rep.ran = true;
    rep.gcStarted = git.runDetached(["gc", "--auto", "--quiet"]) !== undefined;
    rep.repoMb = repoSizeMb(git);
    const maxMb = (() => {
      const v = opts.maxRepoMb?.();
      return typeof v === "number" && v > 0 ? v : DEFAULT_MAX_REPO_MB;
    })();
    if (rep.repoMb > maxMb && recorder.tip()) {
      const busy = opts.legacyBusy();
      // dry run with the 24 h guard decides whether legacy refs may go too
      const dry = resetHistory(git, recorder, sweeper, { dropLegacy: true, minutes: 24 * 60, apply: false });
      const dropLegacy = !dry.refused && !busy;
      const r = resetHistory(git, recorder, sweeper, { dropLegacy, minutes: 24 * 60, apply: true, gcDetached: true });
      rep.reset = r.applied ? (dropLegacy ? "timeline+legacy" : "timeline") : "refused";
      if (!dropLegacy) rep.reason = dry.refused || busy || undefined;
    }
    rep.line =
      `git maintenance: repo ${rep.repoMb.toFixed(0)} MB (limit ${maxMb}), gc --auto ${rep.gcStarted ? "started" : "not started"}, ` +
      `timeline reset: ${rep.reset}${rep.reset === "timeline" && rep.reason ? ` (legacy refs kept: ${rep.reason})` : ""}`;
    return rep;
  } finally {
    unlock(lock);
  }
}
