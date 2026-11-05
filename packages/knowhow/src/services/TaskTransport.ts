/**
 * TaskTransport — ship a local task's working tree (including uncommitted WIP)
 * to another machine (a cloud-worker sandbox) without touching GitHub or the
 * real repo's index/HEAD.
 *
 * Mechanics (see .knowhow/tasks/sbx-git-sync/plan.md §1):
 *  - A "transport commit" is a snapshot of the work tree whose parent is the
 *    real HEAD. It is built with a *separate* GIT_INDEX_FILE under
 *    `.knowhow/transport/` and GIT_ALTERNATE_OBJECT_DIRECTORIES pointing at the
 *    real repo's object store, inside `.knowhow/.git` (or a private repo under
 *    `.knowhow/transport/repo.git` when that does not exist yet). GitPlugin's
 *    index/HEAD are never touched.
 *  - Secret / generated paths are excluded from the snapshot. If such a path is
 *    tracked at HEAD its HEAD entry is kept (so the target sees no spurious
 *    deletion and the secret content is never part of the bundle).
 *  - The bundle is `refs/transport/<taskId> ^<headSha>`.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { git, gitAsync, gitSafe, RealRepoInfo, getRealRepoInfo, normalizeOriginUrl, repoNameFromUrl } from "./RealRepo";

export const DEFAULT_MAX_FILE_MB = 25;
/** PoC backend limit for a single presigned PUT. */
export const MAX_BUNDLE_BYTES = 4.5 * 1024 * 1024 * 1024;

export interface TransportManifest {
  headSha: string;
  branch: string;
  projectSubdir: string;
  changed: number;
  added: number;
  deleted: number;
  filesInSnapshot: number;
  excludedCount: number;
  /** "path (reason)" strings — kept flat so the backend manifest type (string[]) accepts it */
  excluded: string[];
  excludedTruncated: boolean;
  /** os.hostname() of the machine that built the working set (optional; shown as "source machine") */
  hostname?: string;
  /** os.platform() of that machine (optional) */
  platform?: string;
  /** number of files in the snapshot (same as filesInSnapshot; the key the backend reads) */
  fileCount?: number;
}

export interface TransportSnapshot {
  taskId: string;
  commitSha: string;
  baseSha: string;
  bundlePath: string;
  sizeBytes: number;
  sha256: string;
  ref: string;
  /** git tree hash of the working set (stable while the files are unchanged; the commit sha is not) */
  tree: string;
  manifest: TransportManifest;
  /** Remove the temporary bundle (no-op if owned by the caller). */
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Exclusion rules
// ---------------------------------------------------------------------------

export function excludeReason(
  relPath: string,
  extraPrefixes: string[] = []
): string | undefined {
  const p = relPath.replace(/\\/g, "/");
  const segs = p.split("/");
  const base = segs[segs.length - 1];
  if (segs[0] === ".knowhow") return ".knowhow";
  if (segs.includes(".git")) return ".git";
  if (segs.includes("node_modules")) return "node_modules";
  if (segs.includes(".aws")) return ".aws";
  if (base === ".env" || base.startsWith(".env.")) return "env file";
  if (base === ".npmrc") return ".npmrc";
  if (/\.(pem|key|p12)$/i.test(base)) return "key/cert file";
  if (base.startsWith("id_rsa")) return "ssh key";
  for (const prefix of extraPrefixes) {
    if (p === prefix || p.startsWith(prefix + "/")) return "synced via files[]";
  }
  return undefined;
}

/** `knowhow.json` files[].localPath entries, relative to the git root. */
export function configFilePrefixes(
  gitRoot: string,
  cwd: string,
  files: { localPath: string }[] | undefined
): string[] {
  const out: string[] = [];
  for (const f of files || []) {
    if (!f?.localPath) continue;
    const abs = path.resolve(cwd, f.localPath);
    const rel = path.relative(gitRoot, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    out.push(rel.replace(/\/+$/, ""));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport commit
// ---------------------------------------------------------------------------

function resolveObjectsDir(gitRoot: string): string {
  const p = git(["rev-parse", "--git-path", "objects"], { cwd: gitRoot }).trim();
  return path.resolve(gitRoot, p);
}

/**
 * The repo that holds transport objects/refs: `.knowhow/.git` when GitPlugin
 * has created it, else a private bare-ish repo under `.knowhow/transport/`.
 */
export function ensureTransportGitDir(knowhowDir: string): string {
  const pluginGit = path.join(knowhowDir, ".git");
  if (fs.existsSync(path.join(pluginGit, "HEAD"))) return pluginGit;
  const priv = path.join(knowhowDir, "transport", "repo.git");
  if (!fs.existsSync(path.join(priv, "HEAD"))) {
    fs.mkdirSync(priv, { recursive: true });
    git(["init", "--bare", "--quiet", priv]);
  }
  return priv;
}

export interface BuildTransportCommitOptions {
  taskId: string;
  info: RealRepoInfo;
  /** Directory holding `.knowhow/` (usually process.cwd()). */
  knowhowDir: string;
  maxFileMb?: number;
  /** files[] localPath config entries (already relative to gitRoot) */
  extraExcludes?: string[];
}

/** Result of {@link buildTransportCommit}. */
export type BuiltTransportCommit = Awaited<ReturnType<typeof buildTransportCommit>>;

export async function buildTransportCommit(opts: BuildTransportCommitOptions) {
  const { taskId, info, knowhowDir } = opts;
  const maxBytes = (opts.maxFileMb ?? DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  const extra = opts.extraExcludes ?? [];
  const gitDir = ensureTransportGitDir(knowhowDir);
  const transportDir = path.join(knowhowDir, "transport");
  fs.mkdirSync(transportDir, { recursive: true });
  const safeId = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  const indexFile = path.join(transportDir, `${safeId}.index`);
  fs.rmSync(indexFile, { force: true });

  const env: NodeJS.ProcessEnv = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: info.gitRoot,
    GIT_INDEX_FILE: indexFile,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: resolveObjectsDir(info.gitRoot),
    GIT_AUTHOR_NAME: "knowhow-transport",
    GIT_AUTHOR_EMAIL: "transport@knowhow.invalid",
    GIT_COMMITTER_NAME: "knowhow-transport",
    GIT_COMMITTER_EMAIL: "transport@knowhow.invalid",
  };
  const g = (args: string[], input?: string) =>
    gitAsync(
      ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fileMode=true", ...args],
      { cwd: info.gitRoot, env, input }
    );

  try {
    // Candidate files: whatever the REAL repo considers tracked or
    // non-ignored-untracked (honours the real .gitignore). Read-only.
    const listed = (await gitAsync(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: info.gitRoot }
    ))
      .split("\0")
      .filter(Boolean);
    const candidates = Array.from(new Set(listed));

    const include: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const rel of candidates) {
      const reason = excludeReason(rel, extra);
      if (reason) {
        skipped.push({ path: rel, reason });
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(info.gitRoot, rel));
      } catch {
        continue; // deleted in the work tree -> absent from the snapshot
      }
      if (st.isDirectory()) {
        // submodule / nested repo: keep HEAD's entry (if any), never recurse
        skipped.push({ path: rel, reason: "directory entry" });
        continue;
      }
      if (st.isFile() && st.size > maxBytes) {
        skipped.push({
          path: rel,
          reason: `larger than ${Math.round(maxBytes / 1024 / 1024)} MB`,
        });
        continue;
      }
      include.push(rel);
    }

    if (include.length) {
      await g(["update-index", "--add", "-z", "--stdin"], include.join("\0") + "\0");
    } else {
      await g(["read-tree", "--empty"]);
    }

    // Skipped paths that exist at HEAD keep their HEAD entry (no secret
    // content enters the bundle and the target sees no spurious deletion).
    // Also paths excluded by rule but absent from the candidate list (e.g.
    // tracked-then-deleted .env) are covered by scanning HEAD's tree below.
    const headEntries = new Map<string, string>(); // path -> "mode sha"
    const lsTree = await gitAsync(["ls-tree", "-r", "-z", info.headSha], {
      cwd: info.gitRoot,
    });
    for (const rec of lsTree.split("\0").filter(Boolean)) {
      const tab = rec.indexOf("\t");
      const meta = rec.slice(0, tab).split(" "); // mode type sha
      headEntries.set(rec.slice(tab + 1), `${meta[0]} ${meta[2]}`);
    }
    const included = new Set(include);
    const skippedPaths = new Set(skipped.map((s) => s.path));
    const indexInfo: string[] = [];
    for (const [p, modeSha] of headEntries) {
      if (included.has(p)) continue;
      const reason = excludeReason(p, extra);
      const isSkipped = reason !== undefined || skippedPaths.has(p);
      if (!isSkipped) continue;
      // A tracked file deleted from the work tree and not otherwise excluded is
      // a true deletion; only keep excluded/skipped ones.
      indexInfo.push(`${modeSha.split(" ")[0]} ${modeSha.split(" ")[1]}\t${p}\0`);
    }
    // Submodule dirs reported by ls-files (gitlinks) are covered above since
    // they appear in `skipped` and in HEAD's tree as mode 160000 entries.
    if (indexInfo.length) {
      await g(["update-index", "--add", "-z", "--index-info"], indexInfo.join(""));
    }

    const tree = (await g(["write-tree"])).trim();
    const ref = `refs/transport/${taskId}`;
    const commitSha = (await g([
      "commit-tree",
      tree,
      "-p",
      info.headSha,
      "-m",
      `transport ${taskId}`,
    ])).trim();
    await g(["update-ref", ref, commitSha]);

    // Summary vs the real HEAD
    let changed = 0;
    let added = 0;
    let deleted = 0;
    const diff = await g(["diff-tree", "-r", "--no-renames", "--name-status", "-z", info.headSha, commitSha]);
    const parts = diff.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i][0];
      if (status === "A") added++;
      else if (status === "D") deleted++;
      else changed++;
    }

    const excludedAll = skipped.filter((s) => s.reason !== "directory entry");
    const manifest: TransportManifest = {
      headSha: info.headSha,
      branch: info.branch,
      projectSubdir: info.projectSubdir,
      changed,
      added,
      deleted,
      filesInSnapshot: include.length + indexInfo.length,
      excludedCount: excludedAll.length,
      excluded: excludedAll.slice(0, 200).map((e) => `${e.path} (${e.reason})`),
      excludedTruncated: excludedAll.length > 200,
      hostname: os.hostname(),
      platform: os.platform(),
      fileCount: include.length + indexInfo.length,
    };
    return { gitDir, ref, tree, commitSha, manifest, env };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}


// ---------------------------------------------------------------------------
// Bundle creation (local only — no network)
// ---------------------------------------------------------------------------

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Build the transport commit and bundle it as `refs/transport/<taskId>
 * ^<headSha>` into a temp file. Purely local.
 */
export async function createTransportBundle(
  opts: BuildTransportCommitOptions & {
    outFile?: string;
    /** an already built transport commit (skips rebuilding it) */
    prebuilt?: BuiltTransportCommit;
  }
): Promise<TransportSnapshot> {
  const built = opts.prebuilt ?? (await buildTransportCommit(opts));
  const outFile =
    opts.outFile ||
    path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-transport-")),
      "transport.bundle"
    );
  await gitAsync(["bundle", "create", outFile, built.ref, `^${opts.info.headSha}`], {
    cwd: opts.info.gitRoot,
    env: {
      GIT_DIR: built.gitDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: built.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    },
  });
  const sizeBytes = fs.statSync(outFile).size;
  const sha256 = await sha256File(outFile);
  return {
    taskId: opts.taskId,
    commitSha: built.commitSha,
    baseSha: opts.info.headSha,
    bundlePath: outFile,
    sizeBytes,
    sha256,
    ref: built.ref,
    tree: built.tree,
    manifest: built.manifest,
    cleanup: () => {
      if (!opts.outFile) fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
    },
  };
}

/** Create a (full or incremental) base bundle of the real repo's HEAD. */
export async function createBaseBundle(
  info: RealRepoInfo,
  excludeShas: string[],
  outFile: string
) {
  const ref = info.branch ? `refs/heads/${info.branch}` : "HEAD";
  git(
    ["bundle", "create", outFile, ref, ...excludeShas.map((s) => `^${s}`)],
    { cwd: info.gitRoot }
  );
  return {
    ref,
    sizeBytes: fs.statSync(outFile).size,
    sha256: await sha256File(outFile),
  };
}

// ---------------------------------------------------------------------------
// API surface used by the transport (implemented by KnowhowSimpleClient)
// ---------------------------------------------------------------------------

export interface GitBundleInfo {
  id: string;
  kind?: string;
  tipSha: string;
  refs?: { name: string; sha: string }[];
  status: string;
  prerequisiteShas?: string[];
}

export interface TransportClient {
  resolveGitRepository(req: {
    originUrl: string;
    name?: string;
    defaultBranch?: string;
  }): Promise<{ id: string; bundles?: GitBundleInfo[] }>;
  createGitRepositoryBundle(
    repoId: string,
    req: {
      kind: "base" | "incremental" | "transport" | "history";
      tipSha: string;
      refs: { name: string; sha: string }[];
      prerequisiteShas: string[];
      sizeBytes: number;
      sha256: string;
    }
  ): Promise<{ bundleId: string; uploadUrl: string }>;
  completeGitRepositoryBundle(repoId: string, bundleId: string): Promise<unknown>;
  upsertTaskWorkspace(taskId: string, req: TaskWorkspaceRequest): Promise<unknown>;
  createTaskWorkspaceSnapshot(
    taskId: string,
    req: {
      bundleId: string;
      commitSha: string;
      baseSha: string;
      manifest: TransportManifest;
    }
  ): Promise<{ id?: string; seq?: number } & Record<string, unknown>>;
  createTaskOffload(
    taskId: string,
    req: { cloudWorkerId: string; prompt?: string }
  ): Promise<OffloadState>;
  getTaskOffload(taskId: string, offloadId: string): Promise<OffloadState>;
  getTaskWorkspace(taskId: string): Promise<Record<string, any>>;
}

export interface TaskWorkspaceRequest {
  repositoryId?: string;
  baseSha: string;
  baseBranch?: string;
  projectSubdir?: string;
  sourcePlatform?: string;
  sourceRoot?: string;
  runSettings?: Record<string, unknown>;
}

export interface OffloadState {
  id: string;
  state: string;
  log?: { at?: string; step?: string; message?: string }[];
  error?: string | null;
  resumedTaskId?: string | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function putFileToPresignedUrl(url: string, file: string) {
  const size = fs.statSync(file).size;
  const useBuffer = size < 256 * 1024 * 1024;
  const body: any = useBuffer ? fs.readFileSync(file) : fs.createReadStream(file);
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Length": String(size) },
    ...(useBuffer ? {} : { duplex: "half" }),
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

async function uploadBundle(
  client: TransportClient,
  repoId: string,
  file: string,
  meta: {
    kind: "base" | "incremental" | "transport";
    tipSha: string;
    refs: { name: string; sha: string }[];
    prerequisiteShas: string[];
    sizeBytes: number;
    sha256: string;
  }
) {
  if (meta.sizeBytes > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Bundle is ${formatBytes(meta.sizeBytes)}, over the ${formatBytes(
        MAX_BUNDLE_BYTES
      )} PoC limit.`
    );
  }
  const created = await client.createGitRepositoryBundle(repoId, meta);
  await putFileToPresignedUrl(created.uploadUrl, file);
  await client.completeGitRepositoryBundle(repoId, created.bundleId);
  return created.bundleId;
}

// ---------------------------------------------------------------------------
// Base bundles ("repository backup")
// ---------------------------------------------------------------------------

function hasCommit(cwd: string, sha: string) {
  return gitSafe(["cat-file", "-e", `${sha}^{commit}`], { cwd }) !== null;
}
function isAncestor(cwd: string, anc: string, desc: string) {
  return gitSafe(["merge-base", "--is-ancestor", anc, desc], { cwd }) !== null;
}

/**
 * Pure decision: given the repository's ready bundles, which one (if any)
 * already covers HEAD, and which is the best incremental parent?
 */
export function planBaseBundle(
  info: RealRepoInfo,
  bundles: GitBundleInfo[]
): { covered: boolean; parentTip?: string } {
  const ready = bundles.filter(
    (b) => b.status === "ready" && b.kind !== "transport" && b.kind !== "history"
  );
  for (const b of ready) {
    if (b.tipSha === info.headSha) return { covered: true };
    if (hasCommit(info.gitRoot, b.tipSha) && isAncestor(info.gitRoot, info.headSha, b.tipSha)) {
      return { covered: true };
    }
  }
  let best: { tip: string; dist: number } | undefined;
  for (const b of ready) {
    if (!hasCommit(info.gitRoot, b.tipSha)) continue;
    if (!isAncestor(info.gitRoot, b.tipSha, info.headSha)) continue;
    const dist = parseInt(
      gitSafe(["rev-list", "--count", `${b.tipSha}..${info.headSha}`], { cwd: info.gitRoot }) || "0",
      10
    );
    if (!best || dist < best.dist) best = { tip: b.tipSha, dist };
  }
  return { covered: false, parentTip: best?.tip };
}

export async function ensureBaseBundles(
  client: TransportClient,
  repo: { id: string; bundles?: GitBundleInfo[] },
  info: RealRepoInfo,
  log: (m: string) => void = console.log
) {
  const plan = planBaseBundle(info, repo.bundles || []);
  if (plan.covered) {
    log(`✅ Repository base already backed up (HEAD ${info.headSha.slice(0, 8)})`);
    return { uploaded: false as const };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-base-"));
  const file = path.join(dir, "base.bundle");
  try {
    const exclude = plan.parentTip ? [plan.parentTip] : [];
    const { ref, sizeBytes, sha256 } = await createBaseBundle(info, exclude, file);
    log(
      `📦 Uploading ${plan.parentTip ? "incremental" : "full"} base bundle (${formatBytes(
        sizeBytes
      )}) for ${info.headSha.slice(0, 8)}...`
    );
    const bundleId = await uploadBundle(client, repo.id, file, {
      kind: plan.parentTip ? "incremental" : "base",
      tipSha: info.headSha,
      refs: [{ name: ref, sha: info.headSha }],
      prerequisiteShas: exclude,
      sizeBytes,
      sha256,
    });
    return { uploaded: true as const, bundleId, sizeBytes };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


// ---------------------------------------------------------------------------
// Local task metadata
// ---------------------------------------------------------------------------

export const AGENTS_DIR = ".knowhow/processes/agents";

export function readLocalTaskMetadata(
  taskId: string,
  baseDir: string = AGENTS_DIR
): Record<string, any> | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(baseDir, taskId, "metadata.json"), "utf8")
    );
  } catch {
    return undefined;
  }
}

/** Merge `repo` info into the task's metadata.json (the fs channel merges, never overwrites it). */
export function recordTaskRepoInfo(
  taskId: string,
  info: RealRepoInfo,
  baseDir: string = AGENTS_DIR
) {
  const dir = path.join(baseDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "metadata.json");
  const existing = readLocalTaskMetadata(taskId, baseDir) ?? {};
  existing.repo = {
    gitRoot: info.gitRoot,
    projectSubdir: info.projectSubdir,
    headSha: info.headSha,
    branch: info.branch,
    remoteUrl: info.remoteUrl,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Resolve the task to operate on: explicit id, else the most recently updated
 * local task dir. Returns both the local id and the remote task id.
 */
export function resolveLocalTask(
  explicitId?: string,
  baseDir: string = AGENTS_DIR
): { localId: string; remoteId?: string; metadata?: Record<string, any> } {
  if (explicitId) {
    const meta = readLocalTaskMetadata(explicitId, baseDir);
    if (meta) {
      return { localId: explicitId, remoteId: meta.remoteTaskId || meta.knowhowTaskId, metadata: meta };
    }
    // maybe the user passed the remote id
    if (fs.existsSync(baseDir)) {
      for (const d of fs.readdirSync(baseDir)) {
        const m = readLocalTaskMetadata(d, baseDir);
        if (m && (m.remoteTaskId === explicitId || m.knowhowTaskId === explicitId)) {
          return { localId: d, remoteId: explicitId, metadata: m };
        }
      }
    }
    return { localId: explicitId, remoteId: explicitId };
  }
  if (!fs.existsSync(baseDir)) throw new Error("No local agent tasks found (.knowhow/processes/agents).");
  let best: { id: string; mtime: number } | undefined;
  for (const d of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(baseDir, d.name, "metadata.json");
    if (!fs.existsSync(f)) continue;
    const mtime = fs.statSync(f).mtimeMs;
    if (!best || mtime > best.mtime) best = { id: d.name, mtime };
  }
  if (!best) throw new Error("No local agent tasks found (.knowhow/processes/agents).");
  const metadata = readLocalTaskMetadata(best.id, baseDir);
  return {
    localId: best.id,
    remoteId: metadata?.remoteTaskId || metadata?.knowhowTaskId,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Snapshot / push
// ---------------------------------------------------------------------------

export function printSnapshotSummary(
  snap: { sizeBytes: number; manifest: TransportManifest },
  log: (m: string) => void = console.log
) {
  const m = snap.manifest;
  log(
    `📸 Snapshot: ${m.changed} changed, ${m.added} added/untracked, ${m.deleted} deleted ` +
      `(vs HEAD ${m.headSha.slice(0, 8)}), bundle ${formatBytes(snap.sizeBytes)}`
  );
  if (m.excludedCount) {
    const sample = m.excluded.slice(0, 8);
    log(
      `🚫 Excluded ${m.excludedCount} path(s): ${sample.join(", ")}${
        m.excludedCount > sample.length ? ", ..." : ""
      }`
    );
  }
}

export interface RepoContext {
  info: RealRepoInfo;
  cwd: string;
  repo: { id: string; bundles?: GitBundleInfo[] };
}

export async function resolveRepoContext(
  client: TransportClient,
  cwd: string = process.cwd()
): Promise<RepoContext> {
  const info = getRealRepoInfo(cwd);
  if (!info) throw new Error("Not inside a git repository with at least one commit.");
  if (!info.remoteUrl) {
    throw new Error(
      "The git repository has no remote; the sandbox cannot be matched to this repository."
    );
  }
  const repo = await client.resolveGitRepository({
    originUrl: normalizeOriginUrl(info.remoteUrl),
    name: repoNameFromUrl(info.remoteUrl, info.gitRoot),
    defaultBranch: info.branch || undefined,
  });
  return { info, cwd, repo };
}

/** Upsert the task workspace record (runSettings from local metadata). */
export async function upsertWorkspace(
  client: TransportClient,
  taskId: string,
  ctx: RepoContext,
  localMeta?: Record<string, any>
) {
  const runSettings: Record<string, unknown> = {};
  // backend runSettings accepts exactly these keys
  for (const k of ["agentName", "model", "provider"]) {
    if (localMeta?.[k] !== undefined) runSettings[k] = localMeta[k];
  }
  await client.upsertTaskWorkspace(taskId, {
    repositoryId: ctx.repo.id,
    baseSha: ctx.info.headSha,
    baseBranch: ctx.info.branch || undefined,
    projectSubdir: ctx.info.projectSubdir,
    sourcePlatform: `${os.platform()}-${os.hostname()}`,
    sourceRoot: ctx.info.gitRoot,
    runSettings,
  });
}

export async function createSnapshot(
  client: TransportClient,
  taskId: string,
  ctx: RepoContext,
  opts: {
    knowhowDir?: string;
    maxFileMb?: number;
    extraExcludes?: string[];
    log?: (m: string) => void;
    /** already built transport commit (auto-sync builds it first to compare tree hashes) */
    prebuilt?: BuiltTransportCommit;
    /** called with the finished bundle before anything is uploaded; return false to skip the upload */
    beforeUpload?: (snap: TransportSnapshot) => boolean | Promise<boolean>;
    quiet?: boolean;
  } = {}
) {
  const log = opts.log ?? console.log;
  const snap = await createTransportBundle({
    taskId,
    info: ctx.info,
    knowhowDir: opts.knowhowDir ?? path.join(ctx.cwd, ".knowhow"),
    maxFileMb: opts.maxFileMb,
    extraExcludes: opts.extraExcludes,
    prebuilt: opts.prebuilt,
  });
  try {
    if (opts.beforeUpload && (await opts.beforeUpload(snap)) === false) {
      return { snapshot: snap, bundleId: undefined, created: undefined, skipped: true as const };
    }
    if (!opts.quiet) printSnapshotSummary(snap, log);
    const bundleId = await uploadBundle(client, ctx.repo.id, snap.bundlePath, {
      kind: "transport",
      tipSha: snap.commitSha,
      refs: [{ name: snap.ref, sha: snap.commitSha }],
      prerequisiteShas: [snap.baseSha],
      sizeBytes: snap.sizeBytes,
      sha256: snap.sha256,
    });
    const created = await client.createTaskWorkspaceSnapshot(taskId, {
      bundleId,
      commitSha: snap.commitSha,
      baseSha: snap.baseSha,
      manifest: snap.manifest,
    });
    return { snapshot: snap, bundleId, created, skipped: false as const };
  } finally {
    snap.cleanup();
  }
}

/** Push: upsert workspace, make sure the base is backed up, upload a snapshot. */
export async function pushTask(
  client: TransportClient,
  taskId: string,
  opts: {
    cwd?: string;
    metadata?: Record<string, any>;
    maxFileMb?: number;
    configFiles?: { localPath: string }[];
    log?: (m: string) => void;
  } = {}
) {
  const log = opts.log ?? console.log;
  const cwd = opts.cwd ?? process.cwd();
  const ctx = await resolveRepoContext(client, cwd);
  await upsertWorkspace(client, taskId, ctx, opts.metadata);
  await ensureBaseBundles(client, ctx.repo, ctx.info, log);
  const result = await createSnapshot(client, taskId, ctx, {
    maxFileMb: opts.maxFileMb,
    extraExcludes: configFilePrefixes(ctx.info.gitRoot, cwd, opts.configFiles),
    log,
  });
  log(`✅ Snapshot uploaded for task ${taskId}`);
  return { ctx, ...result };
}

// ---------------------------------------------------------------------------
// Offload
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const OFFLOAD_TERMINAL_STATES = new Set(["running", "failed"]);

export async function offload(
  client: TransportClient,
  taskId: string,
  cloudWorkerId: string,
  opts: {
    prompt?: string;
    cwd?: string;
    metadata?: Record<string, any>;
    maxFileMb?: number;
    configFiles?: { localPath: string }[];
    pollMs?: number;
    timeoutMs?: number;
    log?: (m: string) => void;
  } = {}
) {
  const log = opts.log ?? console.log;
  await pushTask(client, taskId, opts);
  log(`🚀 Requesting offload to cloud worker ${cloudWorkerId}...`);
  const created = await client.createTaskOffload(taskId, {
    cloudWorkerId,
    prompt: opts.prompt,
  });
  const pollMs = opts.pollMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60 * 1000);
  let seen = 0;
  let current: OffloadState = created;
  const printNew = (s: OffloadState) => {
    const lines = s.log || [];
    for (; seen < lines.length; seen++) {
      const l = lines[seen];
      log(`   [${l.step ?? s.state}] ${l.message ?? ""}`);
    }
  };
  printNew(current);
  while (!OFFLOAD_TERMINAL_STATES.has(current.state)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the offload to finish.");
    await sleep(pollMs);
    current = await client.getTaskOffload(taskId, created.id);
    printNew(current);
  }
  if (current.state === "failed") {
    throw new Error(`Offload failed: ${current.error || "unknown error"}`);
  }
  log(`✅ Task is now running on the cloud worker (offload ${current.id}).`);
  return current;
}

// ---------------------------------------------------------------------------
// Cloud worker selection helpers
// ---------------------------------------------------------------------------

export interface CloudWorkerSummary {
  id: string;
  name: string;
  status: string;
  repoUrl?: string | null;
  isEphemeral?: boolean | null;
}

/** Workers whose repoUrl matches the local remote come first; otherwise stable order. */
export function rankCloudWorkers<T extends CloudWorkerSummary>(
  workers: T[],
  localRemoteUrl?: string
): T[] {
  const local = localRemoteUrl ? normalizeOriginUrl(localRemoteUrl).toLowerCase() : undefined;
  const matches = (w: T) =>
    !!local && !!w.repoUrl && normalizeOriginUrl(w.repoUrl).toLowerCase() === local;
  // Ephemeral workers (e.g. CI runner sandboxes) are torn down when their job ends — never offload to them.
  return workers
    .filter((w) => !w.isEphemeral)
    .sort((a, b) => Number(matches(b)) - Number(matches(a)));
}

export function findCloudWorker<T extends CloudWorkerSummary>(
  workers: T[],
  spec: string
): T | undefined {
  const s = spec.trim().toLowerCase();
  return (
    workers.find((w) => w.id.toLowerCase() === s) ||
    workers.find((w) => w.name.toLowerCase() === s) ||
    workers.find((w) => w.id.toLowerCase().startsWith(s))
  );
}

export function describeCloudWorker(w: CloudWorkerSummary, localRemoteUrl?: string) {
  const match =
    localRemoteUrl && w.repoUrl &&
    normalizeOriginUrl(w.repoUrl).toLowerCase() === normalizeOriginUrl(localRemoteUrl).toLowerCase();
  return `${w.name} [${w.status}]${w.repoUrl ? ` ${w.repoUrl}` : ""}${match ? "  ← matches this repo" : ""}`;
}
