import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Parts, blobAt, blobIdAt, untrackedByPolicy } from "./Restore";
import { withLock } from "./Lock";
import { TIMELINE_REF, TimelineCommit } from "./types";
import { deleteFile, gitBlobId, readDisk, writeFileAtomic } from "./WorkTreeWriter";

export interface RevertOptions {
  agent: string;
  apply?: boolean;
  exactOnly?: boolean;
  pathGlob?: string;
  caller?: string;
}

export interface RevertReport {
  agent: string;
  applied: boolean;
  commitsConsidered: number;
  ambiguousIncluded: string[];
  ambiguousSkipped: string[];
  reverted: { path: string; commits: string[]; action: "write" | "delete" }[];
  conflicts: { path: string; commit: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  alsoEditedByOthers: { path: string; agents: string[] }[];
  changedMeanwhile: string[];
  revertCommit: string | null;
  note: string;
}

type Content = Buffer | null; // null = file absent

const eq = (a: Content, b: Content) => (a === null || b === null ? a === b : a.equals(b));
const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/** 3-way merge of `ours` with the change base->theirs via `git merge-file -p`. Returns null on conflict. */
function merge3(p: Parts, ours: Buffer, base: Buffer, theirs: Buffer): Buffer | null {
  if (isBinary(ours) || isBinary(base) || isBinary(theirs)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-merge-"));
  try {
    const f = (n: string, b: Buffer) => {
      const x = path.join(dir, n);
      fs.writeFileSync(x, b);
      return x;
    };
    const r = p.git.runBufferEx(["merge-file", "-p", f("ours", ours), f("base", base), f("theirs", theirs)]);
    return r.status === 0 ? r.out : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function globToRe(g: string): RegExp {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`);
}

/**
 * `knowhow history revert --agent X` (design §4, §12.3 C): reverse-apply only X's changes, newest first,
 * 3-way against the current tree (via merge-file), keep every conflicted file as it is. Dry run unless `apply`.
 * Never writes or deletes a path that is ignored or was untracked by policy, and deletes only a file whose
 * bytes still equal the timeline tip's blob. `Kind: untrack` and `Kind: revert` commits are never selected.
 */
export function revertAgent(p: Parts, opts: RevertOptions): RevertReport {
  const report: RevertReport = {
    agent: opts.agent, applied: false, commitsConsidered: 0, ambiguousIncluded: [], ambiguousSkipped: [],
    reverted: [], conflicts: [], skipped: [], alsoEditedByOthers: [], changedMeanwhile: [], revertCommit: null,
    note: "Exec commits revert file contents only; installed dependencies, generated side effects and migrations are not reverted.",
  };
  const lockFile = path.join(p.git.gitDir, "revert.lock");
  const out = withLock(lockFile, 5000, () => run(p, opts, report));
  if (out === undefined) throw new Error("another revert is running (revert.lock)");
  return out;
}

function run(p: Parts, opts: RevertOptions, report: RevertReport): RevertReport {
  // 1) the tip must equal the work tree: unrecorded edits become `user` commits, so they are protected as "others'"
  p.sweeper.sweep({ summary: `before revert of ${opts.agent}`, waitMs: 5000 });
  const tip = p.recorder.tip();
  if (!tip) throw new Error("no timeline");

  // 2) the agent's commits, newest first
  let commits: TimelineCommit[] = p.history
    .log({ agent: opts.agent })
    .filter((c) => c.kind !== "untrack" && c.kind !== "revert" && c.kind !== "marker");
  for (const c of commits) {
    if (c.trailers.Attribution === "ambiguous") {
      (opts.exactOnly ? report.ambiguousSkipped : report.ambiguousIncluded).push(c.sha.slice(0, 8));
    }
  }
  if (opts.exactOnly) commits = commits.filter((c) => c.trailers.Attribution !== "ambiguous");
  report.commitsConsidered = commits.length;

  // 3) per file: its commits newest first
  const re = opts.pathGlob ? globToRe(opts.pathGlob) : null;
  const perFile = new Map<string, string[]>();
  for (const c of commits) {
    const files = p.git
      .run(["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", "--root", "--no-renames", c.sha], { raw: true })
      .split("\0")
      .filter(Boolean);
    for (const f of files) {
      if (re && !re.test(f)) continue;
      if (!perFile.has(f)) perFile.set(f, []);
      perFile.get(f)!.push(c.sha);
    }
  }

  const plan: { rel: string; result: Content; tipBlob: string | null; shas: string[] }[] = [];
  const ignored = p.policy.ignoredAmong(Array.from(perFile.keys()));
  for (const [rel, shas] of perFile) {
    if (ignored.has(rel)) {
      report.skipped.push({ path: rel, reason: "ignored" });
      continue;
    }
    const tipBlob = blobIdAt(p.git, tip, rel);
    if (!tipBlob && untrackedByPolicy(p.git, rel) && readDisk(p.root, rel) !== null) {
      report.skipped.push({ path: rel, reason: "ignored (untracked by policy: ignored or oversize)" });
      continue;
    }
    let state: Content = blobAt(p.git, tip, rel);
    const reverted: string[] = [];
    let blocked: { commit: string; reason: string } | null = null;
    for (const sha of shas) {
      if (blocked) {
        report.conflicts.push({ path: rel, commit: sha.slice(0, 8), reason: `blocked by ${blocked.commit}` });
        continue;
      }
      const base = blobAt(p.git, sha, rel);
      const theirs = blobAt(p.git, `${sha}^`, rel);
      if (eq(state, theirs)) {
        reverted.push(sha.slice(0, 8));
        continue; // already at the pre-image
      }
      if (eq(state, base)) {
        state = theirs;
        reverted.push(sha.slice(0, 8));
        continue;
      }
      if (state !== null && base !== null && theirs !== null) {
        const merged = merge3(p, state, base, theirs);
        if (merged) {
          state = merged;
          reverted.push(sha.slice(0, 8));
          continue;
        }
        blocked = { commit: sha.slice(0, 8), reason: "overlapping changes made later by someone else (or binary file)" };
      } else {
        blocked = { commit: sha.slice(0, 8), reason: state === null ? "file was deleted later by someone else" : "file was changed later by someone else" };
      }
      report.conflicts.push({ path: rel, commit: sha.slice(0, 8), reason: blocked.reason });
    }
    if (blocked) continue; // a conflicted file stays exactly as it is (no partial revert, no markers)
    const cur = blobAt(p.git, tip, rel);
    if (eq(state, cur)) continue;
    plan.push({ rel, result: state, tipBlob, shas: reverted });
  }

  // 4) "also edited by others since": files whose history after the agent's first commit has other authors
  for (const pl of plan) {
    const oldest = perFile.get(pl.rel)![perFile.get(pl.rel)!.length - 1];
    const others = p.history
      .log({ path: pl.rel, since: oldest })
      .map((c) => c.agent)
      .filter((a) => a !== opts.agent && a !== "system");
    if (others.length) report.alsoEditedByOthers.push({ path: pl.rel, agents: Array.from(new Set(others)) });
  }

  for (const pl of plan) {
    report.reverted.push({ path: pl.rel, commits: pl.shas, action: pl.result === null ? "delete" : "write" });
  }
  if (!opts.apply || !plan.length) return report;

  // 5) apply: only files whose disk bytes still equal the tip blob; deletes need the same
  const written: string[] = [];
  for (const pl of plan) {
    const disk = readDisk(p.root, pl.rel);
    const diskId = disk ? gitBlobId(disk) : null;
    if (diskId !== pl.tipBlob) {
      report.changedMeanwhile.push(pl.rel);
      continue;
    }
    if (pl.result === null) deleteFile(p.root, pl.rel);
    else writeFileAtomic(p.root, pl.rel, pl.result);
    written.push(pl.rel);
  }
  report.reverted = report.reverted.filter((r) => written.includes(r.path));
  report.applied = true;
  if (written.length) {
    const shas = plan.filter((x) => written.includes(x.rel)).flatMap((x) => x.shas);
    const r = p.recorder.recordChange({
      agent: opts.caller || "user",
      kind: "revert",
      summary: `revert agent ${opts.agent} (${written.length} file(s))`,
      paths: written,
      trailers: { "Reverts-Agent": opts.agent, Reverts: Array.from(new Set(shas)).join(",").slice(0, 400) },
      realHead: p.realHead(),
    });
    report.revertCommit = r.sha;
  }
  return report;
}

export { TIMELINE_REF };
