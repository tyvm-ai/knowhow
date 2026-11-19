import { GitRunner } from "./GitRunner";
import { Policy } from "./Policy";
import { Recorder } from "./Recorder";
import { Sweeper } from "./Sweeper";
import { History } from "./History";
import { TIMELINE_REF } from "./types";
import { deleteFile, gitBlobId, readDisk, writeFileAtomic } from "./WorkTreeWriter";

export interface Parts {
  git: GitRunner;
  policy: Policy;
  recorder: Recorder;
  sweeper: Sweeper;
  history: History;
  root: string;
  realHead: () => string | undefined;
}

export interface RestoreOptions {
  at?: string;
  beforeAgent?: string;
  apply?: boolean;
  force?: boolean;
  /** who is asking; recorded as the Agent of the revert commit */
  caller?: string;
}

export interface RestoreResult {
  path: string;
  status: "restored" | "would-restore" | "unchanged" | "refused" | "error";
  action?: "write" | "delete";
  source?: string;
  reason?: string;
  commit?: string | null;
}

export function blobAt(git: GitRunner, commit: string, rel: string): Buffer | null {
  if (git.tryRun(["cat-file", "-e", `${commit}:${rel}`]) === null) return null;
  return git.runBuffer(["cat-file", "blob", `${commit}:${rel}`]);
}

export function blobIdAt(git: GitRunner, commit: string, rel: string): string | null {
  return git.tryRun(["rev-parse", "--verify", "-q", `${commit}:${rel}`]) || null;
}

/** Was this path removed from the timeline by a `Kind: untrack` commit (ignored/oversize)? */
export function untrackedByPolicy(git: GitRunner, rel: string): boolean {
  const out = git.tryRun(["log", "-n1", "--format=%H", "-E", "--grep=^Kind: untrack$", TIMELINE_REF, "--", rel]);
  return !!out;
}

/**
 * `knowhow history restore <path> [--at sha | --before-agent id]`: put one file back to an earlier
 * timeline version. Dry run unless `apply`. Refuses ignored / untracked-by-policy paths without `force`.
 * Default source: the version before the newest timeline commit that touched the path.
 */
export function restoreFile(p: Parts, pathArg: string, opts: RestoreOptions = {}): RestoreResult {
  const rel = p.policy.toRel(pathArg);
  if (!rel) return { path: pathArg, status: "refused", reason: "path is outside the project or inside .git/.knowhow" };
  const res = (r: Partial<RestoreResult>): RestoreResult => ({ path: rel, status: "error", ...r });

  if (!opts.force) {
    if (p.policy.ignoredAmong([rel]).has(rel)) {
      return res({ status: "refused", reason: "path is ignored by the project's ignore rules (use --force)" });
    }
    if (untrackedByPolicy(p.git, rel) && !blobIdAt(p.git, TIMELINE_REF, rel)) {
      return res({ status: "refused", reason: "path was untracked by a policy commit (ignored/oversize); the stored copy may be stale (use --force)" });
    }
  }

  // Make the timeline tip equal the work tree first (writes only inside .knowhow/.git), so
  // "previous version" is relative to what is on disk and the restore is itself undoable.
  p.sweeper.sweep({ summary: `before restore of ${rel}`, waitMs: 5000 });

  // pick the source commit
  let source: string | null = null;
  if (opts.at) {
    source = p.git.tryRun(["rev-parse", "--verify", "-q", `${opts.at}^{commit}`]);
    if (!source) return res({ reason: `unknown commit ${opts.at}` });
  } else if (opts.beforeAgent) {
    const mine = p.history.log({ agent: opts.beforeAgent, path: rel }); // newest first
    if (!mine.length) return res({ reason: `agent ${opts.beforeAgent} has no commit touching ${rel}` });
    const first = mine[mine.length - 1].sha;
    source = p.git.tryRun(["rev-parse", "--verify", "-q", `${first}^`]);
    if (!source) return res({ reason: "the agent's first commit is the root commit" });
  } else {
    const last = p.git.tryRun(["log", "-n1", "--format=%H", TIMELINE_REF, "--", rel]);
    if (!last) return res({ reason: `no timeline commit touches ${rel}` });
    source = p.git.tryRun(["rev-parse", "--verify", "-q", `${last}^`]);
    if (!source) return res({ reason: "the newest commit for this path is the root commit" });
  }

  const target = blobAt(p.git, source, rel); // null = absent in source
  const disk = readDisk(p.root, rel);
  const srcShort = source.slice(0, 8);
  if (target === null && disk === null) return res({ status: "unchanged", source: srcShort, reason: "absent then and now" });
  if (target !== null && disk !== null && gitBlobId(target) === gitBlobId(disk)) {
    return res({ status: "unchanged", source: srcShort, reason: "file already equals that version" });
  }
  const action: "write" | "delete" = target === null ? "delete" : "write";
  if (!opts.apply) return res({ status: "would-restore", action, source: srcShort });

  const before = readDisk(p.root, rel);
  if ((before === null) !== (disk === null) || (before && disk && gitBlobId(before) !== gitBlobId(disk))) {
    return res({ reason: "file changed while restoring; retry" });
  }
  if (action === "write") writeFileAtomic(p.root, rel, target!);
  else deleteFile(p.root, rel);
  const r = p.recorder.recordChange({
    agent: opts.caller || "user",
    kind: "revert",
    summary: `restore ${rel} to ${srcShort}`,
    paths: [rel],
    trailers: { Restores: srcShort },
    realHead: p.realHead(),
  });
  return res({ status: "restored", action, source: srcShort, commit: r.sha });
}
