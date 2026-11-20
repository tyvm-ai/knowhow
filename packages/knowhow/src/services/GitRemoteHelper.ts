/**
 * git-remote-knowhow — git remote helper for `knowhow://<orgId>/<name>` urls.
 *
 * git runs `git-remote-knowhow <remote> <url>` for any remote whose url uses the `knowhow://` scheme, so plain
 * `git fetch`, `git pull`, `git push` and `git clone knowhow://...` work against Knowhow repositories.
 * Protocol (gitremote-helpers(7)): capabilities / list / fetch / push over stdin/stdout. stdout is the protocol
 * channel: every log line must go to stderr.
 *
 * Transport is the same as `knowhow repo pull/push` (RepoSync): fetch = load the ready bundle chain into
 * `refs/knowhow-base/*` (which brings the objects in); push = incremental bundle `<sha> ^<remote tip>` uploaded with
 * a compare-and-swap `expectedTip`, so a concurrent push is rejected ("fetch first") instead of overwritten.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitBundleInfo, RepoContext, formatBytes, hasCommit, isAncestor, sha256File, uploadBundle } from "./TaskTransport";
import {
  RepoClient,
  fetchBundleChain,
  getRemoteTip,
  isConflictStatus,
  normalizeRefs,
  readFetchedBundles,
  tipFromBundles,
  writeFetchedBundles,
} from "./RepoSync";
import { git, gitAsync, gitSafe, normalizeOriginUrl, repoNameFromUrl } from "./RealRepo";

export interface RemoteHelperOptions {
  client: RepoClient;
  /** remote url as given to the helper (knowhow://<orgId>/<name>) */
  url: string;
  /** protocol input lines (without trailing newline) */
  input: AsyncIterable<string>;
  /** protocol output (stdout) */
  write: (s: string) => void;
  /** diagnostics (stderr) */
  log?: (m: string) => void;
  /** directory git commands run in; GIT_DIR (set by git for helpers) wins */
  cwd?: string;
  download?: (url: string, dest: string) => Promise<void>;
}

export interface PushSpec {
  force: boolean;
  src: string;
  dst: string;
}

export function parsePushSpec(spec: string): PushSpec {
  const force = spec.startsWith("+");
  const s = force ? spec.slice(1) : spec;
  const i = s.lastIndexOf(":");
  return { force, src: i < 0 ? s : s.slice(0, i), dst: i < 0 ? s : s.slice(i + 1) };
}

/** `list` output lines: `<sha> <ref>` plus a HEAD symref (main, else master, else the first branch). */
export function listLines(refs: Record<string, string>, defaultBranch?: string | null): string[] {
  const names = Object.keys(refs).filter((r) => r.startsWith("refs/")).sort();
  const lines = names.map((r) => `${refs[r]} ${r}`);
  const head = [defaultBranch && `refs/heads/${defaultBranch}`, "refs/heads/main", "refs/heads/master", names.find((n) => n.startsWith("refs/heads/"))]
    .find((r) => r && refs[r]);
  if (head) lines.push(`@${head} HEAD`);
  return lines;
}

async function resolveContext(client: RepoClient, url: string, cwd: string): Promise<RepoContext & { defaultBranch?: string | null }> {
  const repo = (await client.resolveGitRepository({
    originUrl: normalizeOriginUrl(url),
    name: repoNameFromUrl(url, cwd),
  })) as { id: string; bundles?: GitBundleInfo[]; defaultBranch?: string | null };
  const info = { gitRoot: cwd, projectSubdir: "", headSha: "", branch: "", remoteUrl: url, remoteName: undefined };
  return { info, cwd, repo, defaultBranch: repo.defaultBranch };
}

async function remoteRefs(client: RepoClient, ctx: RepoContext): Promise<Record<string, string>> {
  try {
    const refs = normalizeRefs(await client.getGitRepositoryRefs(ctx.repo.id));
    if (Object.keys(refs).length) return refs;
  } catch {
    /* older backend: derive from bundles */
  }
  const bundles = client.getGitRepository ? (await client.getGitRepository(ctx.repo.id)).bundles : ctx.repo.bundles;
  const out: Record<string, string> = {};
  for (const b of bundles || []) for (const r of b.refs || []) {
    const m = /^refs\/(?:knowhow-base\/)?heads\/(.+)$/.exec(r.name);
    if (m) {
      const tip = tipFromBundles(bundles, r.name);
      if (tip) out[`refs/heads/${m[1]}`] = tip;
    }
  }
  return out;
}

/**
 * Bundle `sha` under the name `ref` (git bundles carry the ref names they were made from, and the checkout script
 * reads `refs/heads/<branch>` from them). A throwaway bare repo borrowing our objects via alternates lets us name
 * the ref freely without touching the user's refs.
 */
async function createNamedBundle(cwd: string, ref: string, sha: string, exclude: string | null, file: string) {
  const objects = path.resolve(cwd, git(["rev-parse", "--git-path", "objects"], { cwd }).trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-remote-"));
  try {
    git(["--git-dir", tmp, "init", "--bare", "-q"], { cwd });
    fs.writeFileSync(path.join(tmp, "objects", "info", "alternates"), objects + "\n");
    git(["--git-dir", tmp, "update-ref", ref, sha], { cwd });
    await gitAsync(["--git-dir", tmp, "bundle", "create", "-q", file, ref, ...(exclude ? [`^${exclude}`] : [])], { cwd });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Push one refspec. Returns the protocol status line (`ok <dst>` / `error <dst> <why>`). */
export async function pushOne(
  client: RepoClient,
  ctx: RepoContext,
  spec: PushSpec,
  log: (m: string) => void,
  download?: RemoteHelperOptions["download"]
): Promise<string> {
  const cwd = ctx.cwd;
  const { dst } = spec;
  if (!spec.src) return `error ${dst} deleting branches is not supported on Knowhow repositories`;
  if (!/^refs\/heads\/.+/.test(dst)) return `error ${dst} only branches (refs/heads/*) can be pushed`;
  const sha = gitSafe(["rev-parse", "--verify", "-q", `${spec.src}^{commit}`], { cwd })?.trim();
  if (!sha) return `error ${dst} cannot resolve ${spec.src} to a commit`;
  const tip = await getRemoteTip(client, ctx, dst);
  if (tip === sha) return `ok ${dst}`;
  if (tip && !hasCommit(cwd, tip)) {
    if (!spec.force) return `error ${dst} fetch first`;
    // force: load the chain so the bundle can exclude the remote tip (otherwise fall back to a full bundle)
    await fetchBundleChain(client, ctx, { log, download }).catch(() => 0);
  }
  if (tip && !spec.force && !isAncestor(cwd, tip, sha)) return `error ${dst} non-fast-forward`;
  const exclude = tip && hasCommit(cwd, tip) ? tip : null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-push-"));
  const file = path.join(dir, "push.bundle");
  try {
    await createNamedBundle(cwd, dst, sha, exclude, file);
    const sizeBytes = fs.statSync(file).size;
    log(`knowhow: uploading ${exclude ? "incremental" : "full"} bundle (${formatBytes(sizeBytes)}) for ${dst} ${sha.slice(0, 8)}`);
    let bundleId: string;
    try {
      bundleId = await uploadBundle(client, ctx.repo.id, file, {
        kind: exclude ? "incremental" : "base",
        tipSha: sha,
        refs: [{ name: dst, sha }],
        prerequisiteShas: exclude ? [exclude] : [],
        sizeBytes,
        sha256: await sha256File(file),
        // compare-and-swap against the tip we saw, even for --force (never clobber a push we have not seen)
        expectedTip: { ref: dst, sha: tip },
      });
    } catch (e) {
      if (isConflictStatus(e)) return `error ${dst} fetch first`;
      throw e;
    }
    // same bookkeeping as `knowhow repo push`: we already have these objects
    const branch = dst.slice("refs/heads/".length);
    git(["update-ref", `refs/knowhow-base/heads/${branch}`, sha], { cwd });
    const done = readFetchedBundles(cwd, ctx.repo.id);
    done.add(bundleId);
    writeFetchedBundles(cwd, ctx.repo.id, done);
    return `ok ${dst}`;
  } catch (e: any) {
    return `error ${dst} ${String(e?.message || e).split("\n")[0]}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


/** Fetch: load the bundle chain; if a wanted sha is still missing (stale cache), forget the cache and reload. */
export async function fetchWanted(client: RepoClient, ctx: RepoContext, shas: string[], opts: { log: (m: string) => void; download?: RemoteHelperOptions["download"] }) {
  const missing = () => shas.filter((s) => !hasCommit(ctx.cwd, s));
  if (!missing().length) return;
  await fetchBundleChain(client, ctx, { log: opts.log, download: opts.download });
  if (missing().length) {
    writeFetchedBundles(ctx.cwd, ctx.repo.id, new Set());
    await fetchBundleChain(client, ctx, { log: opts.log, download: opts.download });
  }
  const still = missing();
  if (still.length) throw new Error(`the repository bundles do not contain ${still.map((s) => s.slice(0, 8)).join(", ")}`);
}

/** Run the helper protocol until git sends an empty line / closes stdin. */
export async function runRemoteHelper(opts: RemoteHelperOptions): Promise<void> {
  const { client, url, write } = opts;
  const log = opts.log ?? (() => {});
  const cwd = opts.cwd ?? process.cwd();
  let ctx: (RepoContext & { defaultBranch?: string | null }) | undefined;
  const getCtx = async () => (ctx ??= await resolveContext(client, url, cwd));
  let verbosity = 1;
  const progress = (m: string) => {
    if (verbosity > 0) log(m);
  };

  let batch: { kind: "fetch" | "push"; args: string[] } | undefined;
  const flushBatch = async () => {
    if (!batch) return;
    const b = batch;
    batch = undefined;
    const c = await getCtx();
    if (b.kind === "fetch") {
      await fetchWanted(client, c, b.args.map((a) => a.split(" ")[0]), { log: progress, download: opts.download });
      write("\n");
    } else {
      for (const spec of b.args) write((await pushOne(client, c, parsePushSpec(spec), progress, opts.download)) + "\n");
      write("\n");
    }
  };

  for await (const raw of opts.input) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      if (!batch) return; // end of commands
      await flushBatch();
      continue;
    }
    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    if (cmd === "capabilities") {
      write("fetch\npush\noption\n\n");
    } else if (cmd === "option") {
      const [name, value] = [rest[0], rest.slice(1).join(" ")];
      if (name === "verbosity") {
        verbosity = parseInt(value, 10) || 0;
        write("ok\n");
      } else {
        write("unsupported\n");
      }
    } else if (cmd === "list") {
      const c = await getCtx();
      for (const l of listLines(await remoteRefs(client, c), c.defaultBranch)) write(l + "\n");
      write("\n");
    } else if (cmd === "fetch" || cmd === "push") {
      if (batch && batch.kind !== cmd) await flushBatch();
      batch ??= { kind: cmd, args: [] };
      batch.args.push(arg);
    } else {
      throw new Error(`unsupported remote-helper command: ${line}`);
    }
  }
  await flushBatch();
}

/** Entry point for bin/git-remote-knowhow.js: argv = [remoteName, url]. */
export async function remoteHelperMain(argv: string[] = process.argv.slice(2)) {
  const url = argv[1] || argv[0];
  if (!url || !/^knowhow:\/\//i.test(url)) {
    throw new Error("usage: git-remote-knowhow <remote> knowhow://<orgId>/<name> (run by git, not directly)");
  }
  // stdout is the protocol channel: route every console.* diagnostic to stderr
  const toErr = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  const { KnowhowSimpleClient } = await import("./KnowhowClient");
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    await runRemoteHelper({
      client: new KnowhowSimpleClient() as unknown as RepoClient,
      url,
      input: rl,
      write: (s) => process.stdout.write(s),
      log: (m) => process.stderr.write(m + "\n"),
    });
  } finally {
    rl.close();
  }
}
