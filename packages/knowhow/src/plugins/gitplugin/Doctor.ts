import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import { ensureAlternates } from "./Migration";
import { TIMELINE_REF } from "./types";

export interface DoctorReport {
  ok: boolean;
  problems: string[];
  fixed: string[];
  fullProbeRan: boolean;
  ms: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** Health checks for the history repo (design §6.2): cheap probe on every start, fsck at most daily. */
export class Doctor {
  constructor(private git: GitRunner, private root: string) {}

  private p(...parts: string[]) {
    return path.join(this.git.gitDir, ...parts);
  }

  /** Remove a gc.log older than an hour; git would otherwise suppress auto gc for a day. */
  removeStaleGcLog(): boolean {
    try {
      const st = fs.statSync(this.p("gc.log"));
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) {
        fs.rmSync(this.p("gc.log"), { force: true });
        return true;
      }
    } catch {
      /* none */
    }
    return false;
  }

  /** ~10 ms: tip tree readable, last 100 commits walkable, alternates resolve. */
  fastProbe(): string[] {
    const problems: string[] = [];
    if (this.git.tryRun(["cat-file", "-e", `${TIMELINE_REF}^{tree}`]) === null) {
      problems.push("timeline tip tree unreadable");
    } else if (this.git.tryRun(["rev-list", "-n", "100", TIMELINE_REF]) === null) {
      problems.push("timeline history not walkable");
    }
    // A missing alternates path is not a problem by itself: if objects we need lived there,
    // the tip-tree / rev-list probes above already fail. Moving a repo aside because the
    // real repo was moved would throw away history for nothing.
    return problems;
  }

  /**
   * Connectivity of the timeline only. A repo-wide `fsck` also looks at legacy (V1)
   * refs, transport refs and V1's default index, so damage that V1 left behind would
   * make V2 "repair" (move aside) a repo that V1 is still using.
   */
  fullProbe(): string[] {
    const out = this.git.tryRun(["rev-list", "--objects", "--quiet", TIMELINE_REF], { timeoutMs: 120_000 });
    return out === null ? ["timeline connectivity check failed (missing objects)"] : [];
  }

  /** Repo-wide `fsck --connectivity-only`, reported by `knowhow history doctor --full`; never triggers a repair. */
  fsckAll(): string[] {
    const out = this.git.tryRun(["fsck", "--connectivity-only", "--no-dangling", "--no-progress"], { timeoutMs: 120_000 });
    return out === null ? ["fsck --connectivity-only failed"] : [];
  }

  /**
   * Non-null when a V1 process may be using this repo right now: an index.lock, a
   * merge/rebase in progress, or a legacy ref updated within `windowMs`.
   * Then V2 must not move the repo aside.
   */
  legacyBusy(windowMs = 10 * 60_000): string | null {
    for (const f of ["index.lock", "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (fs.existsSync(this.p(f))) return `${f} present`;
    }
    const out = this.git.tryRun([
      "for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/heads/main", "refs/heads/task/",
    ]);
    for (const l of (out || "").split("\n").filter(Boolean)) {
      const [ref, t] = l.trim().split(" ");
      if (Date.now() - Number(t) * 1000 < windowMs) return `legacy ref ${ref} updated within ${Math.round(windowMs / 60000)} min`;
    }
    return null;
  }

  check(opts: { full?: boolean } = {}): DoctorReport {
    const t0 = Date.now();
    const fixed: string[] = [];
    if (this.removeStaleGcLog()) fixed.push("removed stale gc.log");
    try {
      if (ensureAlternates(this.git.gitDir, this.root)) {
        /* idempotent; nothing to report */
      }
    } catch {
      /* ignore */
    }
    const problems = this.fastProbe();
    let fullProbeRan = false;
    const stamp = this.p("knowhow-fsck.stamp");
    let due = !!opts.full;
    if (!due) {
      try {
        due = Date.now() - fs.statSync(stamp).mtimeMs > DAY;
      } catch {
        due = true;
      }
    }
    if (!problems.length && due) {
      fullProbeRan = true;
      problems.push(...this.fullProbe());
      if (!problems.length) {
        try {
          fs.writeFileSync(stamp, new Date().toISOString());
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: problems.length === 0, problems, fixed, fullProbeRan, ms: Date.now() - t0 };
  }

  /** Move a broken history repo aside (keep newest 2); caller re-initialises. Returns the backup path. */
  moveAside(): string {
    const dir = this.git.gitDir;
    const backup = `${dir}.broken-${Date.now()}`;
    fs.renameSync(dir, backup);
    const parent = path.dirname(dir);
    const base = path.basename(dir) + ".broken-";
    const olds = fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(base))
      .sort()
      .reverse()
      .slice(2);
    for (const o of olds) fs.rmSync(path.join(parent, o), { recursive: true, force: true });
    return backup;
  }
}
