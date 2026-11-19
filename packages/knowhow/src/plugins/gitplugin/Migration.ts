import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import { Policy } from "./Policy";
import { PROTOCOL_VERSION, TIMELINE_REF } from "./types";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface MigrationResult {
  created: boolean; // history repo created fresh
  seededFrom: string | null; // sha timeline was seeded from
  alternates: boolean;
  legacyWarning: string | null;
}

/** Read-only helper: `git rev-parse` in the real project repo. */
export function realRepoGit(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

export function realHeadShort(root: string): string | undefined {
  return realRepoGit(root, ["rev-parse", "--short", "HEAD"]);
}

/** Permanent alternates to the real repo's object store (design §6.1). Idempotent. */
export function ensureAlternates(gitDir: string, root: string): boolean {
  const objects = realRepoGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  if (!objects || !fs.existsSync(objects)) return false;
  if (path.resolve(objects) === path.resolve(gitDir, "objects")) return false;
  const file = path.join(gitDir, "objects", "info", "alternates");
  let cur = "";
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {
    /* none */
  }
  if (cur.split("\n").some((l) => l.trim() === objects)) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + objects + "\n");
  return true;
}

/**
 * Create/adopt the history repo for timeline use (design §12.3 D):
 *  - fresh dir: `git init`, empty root commit on `timeline` (HEAD is left alone)
 *  - legacy repo: seed `timeline` from the commit HEAD resolves to (if missing);
 *    HEAD, the default index and every other ref are left untouched.
 */
export function migrate(git: GitRunner, policy: Policy, root: string, startedAtMs: number): MigrationResult {
  const res: MigrationResult = { created: false, seededFrom: null, alternates: false, legacyWarning: null };
  const dir = git.gitDir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A missing dir and an empty/half-made dir (no HEAD or no objects/) both need `git init`.
  if (!fs.existsSync(path.join(dir, "HEAD")) || !fs.existsSync(path.join(dir, "objects"))) {
    git.run(["init", "--quiet"]);
    res.created = true;
  }
  res.alternates = ensureAlternates(dir, root);
  policy.ensureExcludes();

  if (!git.tryRun(["rev-parse", "--verify", "-q", `${TIMELINE_REF}^{commit}`])) {
    // HEAD first (design 12.3 D); when HEAD is unborn or on a deleted branch fall back to
    // main, then the newest task/* branch, so a V1 history is never silently dropped.
    let seed = git.tryRun(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (!seed) seed = git.tryRun(["rev-parse", "--verify", "-q", "refs/heads/main^{commit}"]);
    if (!seed) {
      const newest = git.tryRun(["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(objectname)", "refs/heads/task/"]);
      if (newest) seed = newest;
    }
    if (seed) {
      git.run(["update-ref", "-m", "knowhow: seed timeline from HEAD", TIMELINE_REF, seed, ""]);
      res.seededFrom = seed;
    } else {
      const msg = "[system] marker: timeline root\n\nAgent: system\nKind: marker";
      // commit-tree accepts the empty tree without it existing; fsck then reports a missing tree
      const tree = git.run(["mktree"], { input: "" }) || EMPTY_TREE;
      const sha = git.run(["commit-tree", tree, "-m", msg]);
      git.run(["update-ref", "-m", "knowhow: timeline root", TIMELINE_REF, sha, ""]);
      // HEAD is never pointed at the timeline: a V1 process sharing this repo would
      // otherwise commit onto it with `add -A` (mixed-version safety, A1).
    }
  }
  try {
    fs.writeFileSync(
      path.join(dir, "knowhow-history.json"),
      JSON.stringify({ protocol: PROTOCOL_VERSION, updatedAt: new Date().toISOString() }) + "\n"
    );
  } catch {
    /* ignore */
  }
  res.legacyWarning = legacyActivity(git, startedAtMs);
  return res;
}

/** Warn when a legacy (V1) CLI updated main/task/* after we started (design §12.3 D). */
export function legacyActivity(git: GitRunner, sinceMs: number): string | null {
  const out = git.tryRun([
    "for-each-ref",
    "--format=%(refname) %(committerdate:unix)",
    "refs/heads/main",
    "refs/heads/task/",
  ]);
  if (!out) return null;
  const hits = out
    .split("\n")
    .map((l) => l.trim().split(" "))
    .filter(([, t]) => Number(t) * 1000 > sinceMs)
    .map(([r]) => r);
  if (!hits.length) return null;
  return `legacy GitPlugin (V1) appears to be running on this repo (updated: ${hits.slice(0, 3).join(", ")}); it runs checkout/merge on the shared work tree`;
}
