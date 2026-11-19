import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import { Policy } from "./Policy";
import { Recorder } from "./Recorder";
import { withLock } from "./Lock";
import { TIMELINE_REF } from "./types";

export interface SweepResult {
  swept: string[];
  untracked: string[];
  skippedOversize: string[];
  sweepSha: string | null;
  untrackSha: string | null;
  skipped: boolean;
}

const EMPTY: SweepResult = {
  swept: [], untracked: [], skippedOversize: [], sweepSha: null, untrackSha: null, skipped: false,
};

/**
 * Finds what changed in the work tree relative to the timeline tip and records
 * it (design §2.4). Uses a persistent private index (`sweep.index`) so stat
 * data survives between sweeps; it is never the repo's default index.
 */
export class Sweeper {
  private indexFile: string;
  private tipFile: string;
  private lockFile: string;

  constructor(
    private git: GitRunner,
    private recorder: Recorder,
    private policy: Policy,
    private realHead: () => string | undefined
  ) {
    this.indexFile = path.join(git.gitDir, "sweep.index");
    this.tipFile = path.join(git.gitDir, "sweep.index.tip");
    this.lockFile = path.join(git.gitDir, "sweep.lock");
  }

  private io() {
    return { indexFile: this.indexFile };
  }

  private recordedTip(): string | null {
    try {
      if (!fs.existsSync(this.indexFile)) return null;
      return fs.readFileSync(this.tipFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private setRecordedTip(tip: string) {
    fs.writeFileSync(this.tipFile, tip + "\n");
  }

  /** Bring the sweep index to `tip`, keeping stat data for paths that did not change. */
  private syncIndex(tip: string) {
    const rec = this.recordedTip();
    if (rec === tip) return;
    let done = false;
    if (rec && this.git.tryRun(["cat-file", "-e", `${rec}^{commit}`]) !== null) {
      try {
        const out = this.git.runZ(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", rec, tip]);
        const lines: string[] = [];
        // -z format: ":oldmode newmode oldsha newsha status" NUL path NUL
        for (let i = 0; i + 1 < out.length; i += 2) {
          const meta = out[i].split(" ");
          const p = out[i + 1];
          const newMode = meta[1];
          const newSha = meta[3];
          if (newMode === "000000") lines.push(`0 ${"0".repeat(40)}\t${p}`);
          else lines.push(`${newMode} ${newSha}\t${p}`);
        }
        if (lines.length) {
          this.git.run(["update-index", "--index-info"], { ...this.io(), input: lines.join("\n") + "\n" });
        }
        done = true;
      } catch {
        done = false;
      }
    }
    if (!done) this.git.run(["read-tree", tip], this.io());
    this.setRecordedTip(tip);
  }

  private refresh() {
    this.git.run(["update-index", "-q", "--refresh"], { ...this.io(), allowFail: true });
  }

  /** Dirty paths vs the synced sweep index (no recording). */
  private listDirty(): { modified: string[]; untracked: string[] } {
    const modified = this.git.runZ(["diff-files", "--name-only", "-z"], this.io());
    const untracked = this.git.runZ(["ls-files", "-o", "--exclude-standard", "-z"], this.io());
    // gitPlugin.include: ignored-but-wanted paths. New files there are found by walking the listed roots only.
    if (this.policy.include.enabled) {
      const roots = this.policy.include.roots();
      const known = new Set<string>(
        roots.length ? this.git.runZ(["ls-files", "-z", "--", ...roots.map((r) => `:(literal)${r}`)], this.io()) : []
      );
      const seen = new Set(untracked);
      for (const f of this.policy.include.walk()) {
        if (!known.has(f) && !seen.has(f)) untracked.push(f);
      }
    }
    return { modified, untracked };
  }

  /** Read-only: dirty paths vs the timeline tip. Returns null when it could not run. */
  dirtyPaths(waitMs = 2000): string[] | null {
    const res = withLock(this.lockFile, waitMs, () => {
      const tip = this.recorder.tip();
      if (!tip) return null;
      this.syncIndex(tip);
      this.refresh();
      const d = this.listDirty();
      return Array.from(new Set([...d.modified, ...d.untracked]));
    });
    return res === undefined ? null : res;
  }

  /** Record every dirty path as `Agent: user, Kind: sweep`, after an `untrack` commit for paths that became ignored/oversize. */
  sweep(opts: { summary?: string; waitMs?: number } = {}): SweepResult {
    const res = withLock(this.lockFile, opts.waitMs ?? 3000, () => this.sweepLocked(opts.summary));
    return res === undefined ? { ...EMPTY, skipped: true } : res;
  }

  private sweepLocked(summary?: string): SweepResult {
    const out: SweepResult = { ...EMPTY, swept: [], untracked: [], skippedOversize: [] };
    const tipBefore = this.recorder.tip();
    if (!tipBefore) return out;
    this.syncIndex(tipBefore);
    this.refresh();

    // 1) §12.3 B: tracked paths that are now ignored or oversize leave the timeline index only
    const ignoredTracked = this.git
      .runZ(["ls-files", "-ci", "--exclude-standard", "-z"], this.io())
      .filter((p) => !this.policy.include.isIncluded(p)); // gitPlugin.include is exempt from the untrack policy
    const modifiedNow = this.git.runZ(["diff-files", "--name-only", "-z"], this.io());
    const grown = modifiedNow.filter((p) => this.policy.isOversize(p));
    const toUntrack = Array.from(new Set([...ignoredTracked, ...grown]));
    if (toUntrack.length) {
      const r = this.recorder.recordChange({
        agent: "system",
        kind: "untrack",
        summary: `untrack ${toUntrack.length} ignored/oversize path(s)`,
        paths: toUntrack,
        forceRemove: true,
        realHead: this.realHead(),
      });
      out.untrackSha = r.sha;
      out.untracked = toUntrack;
      this.git.run(["update-index", "--force-remove", "-z", "--stdin"], {
        ...this.io(),
        input: toUntrack.join("\0") + "\0",
      });
    }

    // 2) everything else that differs
    const d = this.listDirty();
    const f = this.policy.filter([...d.modified, ...d.untracked], { trusted: true });
    out.skippedOversize = f.skippedOversize;
    if (f.keep.length) {
      const r = this.recorder.recordChange({
        agent: "user",
        kind: "sweep",
        summary: summary || `${f.keep.length} file(s) changed outside agent edits`,
        paths: f.keep,
        realHead: this.realHead(),
        bulk: f.keep.length > 500,
      });
      out.sweepSha = r.sha;
      out.swept = r.sha ? r.files : [];
      this.git.run(["update-index", "--add", "--remove", "-z", "--stdin"], {
        ...this.io(),
        input: f.keep.join("\0") + "\0",
      });
    }
    const after = this.recorder.tip();
    if (after && out.sweepSha && after === out.sweepSha) {
      const parent = this.git.tryRun(["rev-parse", `${out.sweepSha}^`]);
      if (parent === tipBefore || (out.untrackSha && parent === out.untrackSha)) this.setRecordedTip(after);
    }
    return out;
  }

  /** For tests/doctor: drop the persistent index. */
  reset() {
    for (const f of [this.indexFile, this.tipFile]) fs.rmSync(f, { force: true });
  }
}

export { TIMELINE_REF };
