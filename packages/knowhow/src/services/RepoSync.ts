/**
 * RepoSync — `knowhow repo init --hosted | push | pull | status`.
 *
 * Git = bundles only (see .knowhow/tasks/min-app-updates/revised-plan.md §1). A repository is a chain of ready
 * base/incremental bundles in creation order; the sandbox checkout script fetches them with
 * `+refs/*:refs/knowhow-base/*`, so the newest bundle carrying `refs/heads/<b>` decides the branch tip.
 * We do exactly the same locally, and push incremental bundles `<branch> ^<known tip>` with a compare-and-swap
 * `expectedTip` so two writers cannot silently overwrite each other (backend answers 409).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GitBundleInfo,
  RepoContext,
  TransportClient,
  formatBytes,
  hasCommit,
  isAncestor,
  resolveRepoContext,
  sha256File,
  uploadBundle,
} from "./TaskTransport";
import { git, gitAsync, gitSafe, getRealRepoInfo, KNOWHOW_REMOTE } from "./RealRepo";

export interface RepoClient extends TransportClient {
  createHostedGitRepository(name: string): Promise<{
    id: string;
    name?: string;
    originUrl: string;
    bundles?: GitBundleInfo[];
  }>;
  getGitRepositoryRefs(repoId: string): Promise<Record<string, string> | unknown>;
  getGitRepository?(repoId: string): Promise<{ id: string; bundles?: GitBundleInfo[] }>;
  getGitBundleDownloadUrl(repoId: string, bundleId: string): Promise<{ url: string }>;
}

export type Log = (m: string) => void;

export interface RepoOptions {
  cwd?: string;
  branch?: string;
  /** prefer this git remote when finding the repository (default: upstream's, origin, knowhow) */
  remote?: string;
  log?: Log;
  /** download a presigned bundle url to a file (tests inject a local copy) */
  download?: (url: string, dest: string) => Promise<void>;
}

const BASE_REF_PREFIX = "refs/knowhow-base/";
const CHAIN_KINDS = new Set(["base", "incremental", "history"]);

export class RepoConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoConflictError";
  }
}

/**
 * The backend answers a stale `expectedTip` with HTTP 409 and `{ error: { message, details: { currentSha } } }`
 * (AppError → the global error middleware). HttpError carries the status and the parsed body.
 */
export function isConflictStatus(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | undefined;
  return !!e && (e.status === 409 || /\b409\b/.test(e.message || ""));
}

/** Current remote tip reported by a 409 (`error.details.currentSha`); null = branch does not exist, undefined = unknown. */
export function conflictCurrentSha(err: unknown): string | null | undefined {
  const details = (err as { body?: { error?: { details?: { currentSha?: unknown } } } })?.body?.error?.details;
  if (!details || !("currentSha" in details)) return undefined;
  return typeof details.currentSha === "string" ? details.currentSha : null;
}

/** Backend rule for hosted names: 1-100 chars of letters, digits, `.`, `_`, `-` (not `.`/`..`). */
export function hostedRepoName(raw: string, strict: boolean): string {
  const name = raw.trim();
  const ok = (n: string) => /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== "." && n !== "..";
  if (ok(name)) return name;
  if (strict) throw new Error(`Invalid repository name '${raw}': use 1-100 letters, digits, '.', '_' or '-'.`);
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  if (!ok(cleaned)) throw new Error(`Cannot derive a repository name from '${raw}': pass --name <name>.`);
  return cleaned;
}

export async function defaultDownload(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bundle download failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// Fetched-bundle cache: .git/knowhow-bundles.json  { [repoId]: bundleId[] }
// ---------------------------------------------------------------------------

function cacheFile(gitRoot: string) {
  const p = git(["rev-parse", "--git-path", "knowhow-bundles.json"], { cwd: gitRoot }).trim();
  return path.resolve(gitRoot, p);
}

export function readFetchedBundles(gitRoot: string, repoId: string): Set<string> {
  try {
    const all = JSON.parse(fs.readFileSync(cacheFile(gitRoot), "utf8"));
    return new Set<string>(Array.isArray(all?.[repoId]) ? all[repoId] : []);
  } catch {
    return new Set();
  }
}

export function writeFetchedBundles(gitRoot: string, repoId: string, ids: Set<string>) {
  const file = cacheFile(gitRoot);
  let all: Record<string, string[]> = {};
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    /* new file */
  }
  all[repoId] = [...ids];
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

// ---------------------------------------------------------------------------
// Remote tips
// ---------------------------------------------------------------------------

/** Accepts {refs/heads/x: sha}, {headRefs: {...}}, {refs: [...]}, or [{name, sha}] */
export function normalizeRefs(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const r of v) {
        const x = r as { name?: unknown; ref?: unknown; sha?: unknown };
        const name = typeof x?.name === "string" ? x.name : typeof x?.ref === "string" ? x.ref : undefined;
        if (name && typeof x.sha === "string") out[name] = x.sha;
      }
      return;
    }
    const o = v as Record<string, unknown>;
    for (const k of ["headRefs", "refs"]) if (o[k] && typeof o[k] === "object") return visit(o[k]);
    for (const [k, val] of Object.entries(o)) if (typeof val === "string" && /^refs\//.test(k)) out[k] = val;
  };
  visit(data);
  return out;
}

/** Tip of `ref` from the newest ready chain bundle that carries it (what the checkout script resolves). */
export function tipFromBundles(bundles: GitBundleInfo[] | undefined, ref: string): string | null {
  let tip: string | null = null;
  for (const b of bundles || []) {
    if (b.status !== "ready" || !CHAIN_KINDS.has(b.kind || "base")) continue;
    for (const r of b.refs || []) if (r.name === ref) tip = r.sha;
  }
  return tip;
}

export async function getRemoteTip(client: RepoClient, ctx: RepoContext, ref: string): Promise<string | null> {
  try {
    const refs = normalizeRefs(await client.getGitRepositoryRefs(ctx.repo.id));
    if (Object.keys(refs).length) return refs[ref] ?? null;
  } catch {
    /* older backend (no /refs endpoint): fall back to the bundle refs */
  }
  let bundles = ctx.repo.bundles;
  if (client.getGitRepository) {
    try {
      bundles = (await client.getGitRepository(ctx.repo.id)).bundles ?? bundles;
    } catch {
      /* use what resolve returned */
    }
  }
  return tipFromBundles(bundles, ref);
}

async function getChain(client: RepoClient, ctx: RepoContext): Promise<GitBundleInfo[]> {
  if (client.getGitRepository) {
    try {
      const r = await client.getGitRepository(ctx.repo.id);
      if (r.bundles) return r.bundles;
    } catch {
      /* fall through */
    }
  }
  return ctx.repo.bundles || [];
}

/**
 * Fetch every ready base/incremental bundle (creation order) that we have not fetched yet into
 * `refs/knowhow-base/*`. Returns how many bundles were fetched.
 */
export async function fetchBundleChain(client: RepoClient, ctx: RepoContext, opts: RepoOptions = {}) {
  const log = opts.log ?? (() => {});
  const download = opts.download ?? defaultDownload;
  const chain = (await getChain(client, ctx)).filter(
    (b) => b.status === "ready" && CHAIN_KINDS.has(b.kind || "base")
  );
  const done = readFetchedBundles(ctx.info.gitRoot, ctx.repo.id);
  let fetched = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-pull-"));
  try {
    for (const b of chain) {
      if (done.has(b.id)) continue;
      const { url } = await client.getGitBundleDownloadUrl(ctx.repo.id, b.id);
      const file = path.join(dir, `${b.id}.bundle`);
      await download(url, file);
      log(`⬇️  fetching bundle ${b.id.slice(0, 8)} (${formatBytes(fs.statSync(file).size)})`);
      // --no-write-fetch-head: inside `git pull` (via git-remote-knowhow) our FETCH_HEAD entry would become a
      // second merge head next to the one git itself records.
      await gitAsync(["fetch", "--quiet", "--no-write-fetch-head", file, `+refs/*:${BASE_REF_PREFIX}*`], {
        cwd: ctx.info.gitRoot,
      });
      done.add(b.id);
      fetched++;
      writeFetchedBundles(ctx.info.gitRoot, ctx.repo.id, done);
      fs.rmSync(file, { force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return fetched;
}


// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export async function resolveCtx(
  client: RepoClient,
  opts: RepoOptions,
  allowUnborn = false
): Promise<RepoContext> {
  return resolveRepoContext(client, opts.cwd ?? process.cwd(), opts.remote, allowUnborn);
}

function branchOf(ctx: RepoContext, opts: RepoOptions): string {
  const b = opts.branch || ctx.info.branch;
  if (!b) throw new Error("HEAD is detached: pass --branch <name>.");
  return b;
}

function localSha(cwd: string, ref: string): string | null {
  return gitSafe(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd })?.trim() || null;
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

export interface PullResult {
  branch: string;
  status: "no-remote-branch" | "up-to-date" | "ahead" | "fast-forwarded" | "rebased" | "created";
  remoteTip: string | null;
  fetchedBundles: number;
}

/** Integrate `refs/knowhow-base/heads/<branch>` into the local branch (fast-forward, else rebase). */
export async function pullRepo(
  client: RepoClient,
  opts: RepoOptions = {},
  preCtx?: RepoContext
): Promise<PullResult> {
  const ctx = preCtx ?? (await resolveCtx(client, opts, true));
  const cwd = ctx.info.gitRoot;
  const log = opts.log ?? (() => {});
  const branch = branchOf(ctx, opts);
  const fetchedBundles = await fetchBundleChain(client, ctx, opts);
  const remoteTip = localSha(cwd, `${BASE_REF_PREFIX}heads/${branch}`);
  const result = (status: PullResult["status"]): PullResult => ({ branch, status, remoteTip, fetchedBundles });
  if (!remoteTip) return result("no-remote-branch");

  const ref = `refs/heads/${branch}`;
  const local = localSha(cwd, ref);
  const current = gitSafe(["branch", "--show-current"], { cwd })?.trim();
  if (!local) {
    if (current === branch) {
      // unborn branch (fresh `git init`): HEAD already points at it, so populate index + work tree
      git(["update-ref", ref, remoteTip], { cwd });
      git(["reset", "--hard", "-q"], { cwd });
    } else {
      git(["branch", branch, remoteTip], { cwd });
    }
    log(`created local branch ${branch} at ${remoteTip.slice(0, 8)}`);
    return result("created");
  }
  if (local === remoteTip) return result("up-to-date");
  if (isAncestor(cwd, remoteTip, local)) return result("ahead");
  if (isAncestor(cwd, local, remoteTip)) {
    if (current === branch) git(["merge", "--ff-only", remoteTip], { cwd });
    else git(["update-ref", ref, remoteTip, local], { cwd });
    log(`fast-forwarded ${branch} to ${remoteTip.slice(0, 8)}`);
    return result("fast-forwarded");
  }
  // diverged: rebase the local commits onto the remote tip
  if (current !== branch) {
    throw new Error(
      `${branch} has diverged from the remote (${remoteTip.slice(0, 8)}); check it out and run \`knowhow repo pull\` to rebase.`
    );
  }
  try {
    git(["rebase", remoteTip], { cwd });
  } catch (e: any) {
    gitSafe(["rebase", "--abort"], { cwd });
    throw new RepoConflictError(
      `Rebasing ${branch} onto the remote tip ${remoteTip.slice(0, 8)} hit conflicts; the rebase was aborted and your branch is unchanged. ` +
        `Resolve manually: \`git rebase ${BASE_REF_PREFIX}heads/${branch}\`, then \`knowhow repo push\`.\n${(e?.stderr || e?.message || "").toString().slice(0, 500)}`
    );
  }
  log(`rebased ${branch} onto ${remoteTip.slice(0, 8)}`);
  return result("rebased");
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

export interface PushResult {
  branch: string;
  status: "pushed" | "up-to-date";
  sha: string;
  previousTip: string | null;
  bundleId?: string;
  sizeBytes?: number;
  /** true when a conflict (409 / diverged tip) was resolved by pull + rebase */
  rebased?: boolean;
}

/**
 * Push `branch` as an incremental bundle `<branch> ^<remote tip>` with compare-and-swap. On 409 (someone else
 * pushed first) or a diverged tip: pull (fetch chain + rebase) and retry once. Exported for `knowhow app publish`.
 */
export async function pushRepo(client: RepoClient, opts: RepoOptions = {}): Promise<PushResult> {
  const log = opts.log ?? (() => {});
  const ctx = await resolveCtx(client, opts);
  const cwd = ctx.info.gitRoot;
  const branch = branchOf(ctx, opts);
  const ref = `refs/heads/${branch}`;
  if (!localSha(cwd, ref)) throw new Error(`Local branch ${branch} does not exist.`);
  let rebased = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const sha = localSha(cwd, ref)!;
    const tip = await getRemoteTip(client, ctx, ref);
    if (tip === sha) return { branch, status: "up-to-date", sha, previousTip: tip, rebased };
    // The remote moved past us (or we have never seen its tip): integrate first.
    if (tip && (!hasCommit(cwd, tip) || !isAncestor(cwd, tip, sha))) {
      if (attempt > 0) throw new RepoConflictError(`The remote ${branch} moved again while pushing; run \`knowhow repo pull\` and retry.`);
      if (!hasCommit(cwd, tip)) log(`remote ${branch} is at ${tip.slice(0, 8)}, which is not local yet: pulling first`);
      else log(`remote ${branch} has commits you do not have: rebasing onto ${tip.slice(0, 8)}`);
      const pulled = await pullRepo(client, { ...opts, branch }, ctx);
      rebased = rebased || pulled.status === "rebased";
      continue;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-push-"));
    const file = path.join(dir, "push.bundle");
    try {
      await gitAsync(["bundle", "create", file, ref, ...(tip ? [`^${tip}`] : [])], { cwd });
      const sizeBytes = fs.statSync(file).size;
      const sha256 = await sha256File(file);
      log(`📦 Uploading ${tip ? "incremental" : "full"} bundle (${formatBytes(sizeBytes)}) for ${branch} ${sha.slice(0, 8)}`);
      let bundleId: string;
      try {
        bundleId = await uploadBundle(client, ctx.repo.id, file, {
          kind: tip ? "incremental" : "base",
          tipSha: sha,
          refs: [{ name: ref, sha }],
          prerequisiteShas: tip ? [tip] : [],
          sizeBytes,
          sha256,
          expectedTip: { ref, sha: tip },
        });
      } catch (e) {
        if (isConflictStatus(e) && attempt === 0) {
          const current = conflictCurrentSha(e);
          log(
            `push rejected (409): the remote ${branch} moved${current ? ` to ${current.slice(0, 8)}` : ""}; pulling and retrying once`
          );
          const pulled = await pullRepo(client, { ...opts, branch }, ctx);
          rebased = rebased || pulled.status === "rebased";
          continue;
        }
        if (isConflictStatus(e)) {
          throw new RepoConflictError(`Push rejected again (409): run \`knowhow repo pull\` and retry.`);
        }
        throw e;
      }
      // we have these objects: remember the bundle and the remote-tracking ref
      git(["update-ref", `${BASE_REF_PREFIX}heads/${branch}`, sha], { cwd });
      const done = readFetchedBundles(cwd, ctx.repo.id);
      done.add(bundleId);
      writeFetchedBundles(cwd, ctx.repo.id, done);
      return { branch, status: "pushed", sha, previousTip: tip, bundleId, sizeBytes, rebased };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new RepoConflictError(`Could not push ${branch}: the remote kept moving.`);
}

// ---------------------------------------------------------------------------
// init --hosted
// ---------------------------------------------------------------------------

export interface InitResult {
  repositoryId: string;
  originUrl: string;
  remote: string;
  uploaded: boolean;
  bundleId?: string;
}

export async function initHostedRepo(
  client: RepoClient,
  opts: RepoOptions & { name?: string } = {}
): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? (() => {});
  const info = getRealRepoInfo(cwd, KNOWHOW_REMOTE);
  if (!info) throw new Error("Not inside a git repository with at least one commit (git init && git commit first).");
  const name = opts.name ? hostedRepoName(opts.name, true) : hostedRepoName(path.basename(info.gitRoot), false);
  const repo = await client.createHostedGitRepository(name);
  const remotes = (gitSafe(["remote"], { cwd: info.gitRoot }) || "").split("\n").map((r) => r.trim());
  if (remotes.includes(KNOWHOW_REMOTE)) git(["remote", "set-url", KNOWHOW_REMOTE, repo.originUrl], { cwd: info.gitRoot });
  else git(["remote", "add", KNOWHOW_REMOTE, repo.originUrl], { cwd: info.gitRoot });
  log(`🔗 remote '${KNOWHOW_REMOTE}' -> ${repo.originUrl}`);

  const hasChain = (repo.bundles || []).some((b) => b.status === "ready" && CHAIN_KINDS.has(b.kind || "base"));
  if (hasChain) {
    log("repository already has bundles: pushing the current branch instead of a new base bundle");
    const pushed = await pushRepo(client, { ...opts, cwd, remote: KNOWHOW_REMOTE });
    return { repositoryId: repo.id, originUrl: repo.originUrl, remote: KNOWHOW_REMOTE, uploaded: pushed.status === "pushed", bundleId: pushed.bundleId };
  }
  if (gitSafe(["rev-parse", "--is-shallow-repository"], { cwd: info.gitRoot })?.trim() === "true") {
    throw new Error("Repository is a shallow clone: run `git fetch --unshallow` first.");
  }
  const refs = (gitSafe(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], { cwd: info.gitRoot }) || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, name] = l.split(" ");
      return { name, sha };
    });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-init-"));
  const file = path.join(dir, "base.bundle");
  try {
    await gitAsync(["bundle", "create", file, ...refs.map((r) => r.name)], { cwd: info.gitRoot });
    const sizeBytes = fs.statSync(file).size;
    log(`📦 Uploading base bundle (${formatBytes(sizeBytes)}, ${refs.length} refs)`);
    const bundleId = await uploadBundle(client, repo.id, file, {
      kind: "base",
      tipSha: info.headSha,
      refs,
      prerequisiteShas: [],
      sizeBytes,
      sha256: await sha256File(file),
    });
    const done = readFetchedBundles(info.gitRoot, repo.id);
    done.add(bundleId);
    writeFetchedBundles(info.gitRoot, repo.id, done);
    return { repositoryId: repo.id, originUrl: repo.originUrl, remote: KNOWHOW_REMOTE, uploaded: true, bundleId };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusResult {
  repositoryId: string;
  originUrl: string | undefined;
  remoteName: string | undefined;
  branch: string;
  localTip: string | null;
  remoteTip: string | null;
  state: "in-sync" | "ahead" | "behind" | "diverged" | "not-pushed" | "remote-unknown-commit";
  ahead?: number;
  behind?: number;
}

export async function repoStatus(client: RepoClient, opts: RepoOptions = {}): Promise<StatusResult> {
  const ctx = await resolveCtx(client, opts);
  const cwd = ctx.info.gitRoot;
  const branch = branchOf(ctx, opts);
  const ref = `refs/heads/${branch}`;
  const localTip = localSha(cwd, ref);
  const remoteTip = await getRemoteTip(client, ctx, ref);
  const base = {
    repositoryId: ctx.repo.id,
    originUrl: ctx.info.remoteUrl,
    remoteName: ctx.info.remoteName,
    branch,
    localTip,
    remoteTip,
  };
  if (!remoteTip) return { ...base, state: "not-pushed" };
  if (localTip === remoteTip) return { ...base, state: "in-sync" };
  if (!hasCommit(cwd, remoteTip)) return { ...base, state: "remote-unknown-commit" };
  const count = (range: string) => parseInt(gitSafe(["rev-list", "--count", range], { cwd })?.trim() || "0", 10);
  const ahead = localTip ? count(`${remoteTip}..${localTip}`) : 0;
  const behind = localTip ? count(`${localTip}..${remoteTip}`) : 0;
  const state = ahead && behind ? "diverged" : ahead ? "ahead" : "behind";
  return { ...base, state, ahead, behind };
}
