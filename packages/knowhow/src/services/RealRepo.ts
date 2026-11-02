/**
 * Helpers for inspecting the user's *real* git repository (not the internal
 * `.knowhow/.git` tracking repo used by GitPlugin). All git calls use
 * execFile-style argument arrays — never shell strings.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface RealRepoInfo {
  /** Absolute path of the git top-level directory */
  gitRoot: string;
  /** cwd relative to gitRoot ("" when cwd is the root), POSIX separators */
  projectSubdir: string;
  /** Full sha of HEAD */
  headSha: string;
  /** Current branch ("" when detached) */
  branch: string;
  /** URL of the preferred remote (upstream's remote, else origin, else first) */
  remoteUrl: string | undefined;
  /** Name of that remote */
  remoteName: string | undefined;
}

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** Return stdout as a Buffer (default: utf8 string) */
  maxBuffer?: number;
}

/** Run git with an argument array. Throws on non-zero exit. */
export function git(args: string[], opts: GitOptions = {}): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
  });
}

/** Like git() but returns null instead of throwing. */
export function gitSafe(args: string[], opts: GitOptions = {}): string | null {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

/** Strip credentials from a remote URL so it is safe to store/send. */
export function sanitizeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Normalise a remote URL to its https form (lowercase host, no creds, no .git
 * suffix) so ssh/https clones of the same repo resolve to the same repository.
 */
export function normalizeOriginUrl(url: string): string {
  let u = url.trim();
  // scp-like: git@github.com:owner/repo.git
  const scp = u.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    u = `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    const p = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return `https://${host}${p}`;
  } catch {
    return u.replace(/\.git$/i, "");
  }
}

export function repoNameFromUrl(url: string | undefined, gitRoot: string) {
  if (url) {
    const n = normalizeOriginUrl(url).split("/").filter(Boolean).pop();
    if (n) return n;
  }
  return path.basename(gitRoot);
}

function pickRemote(gitRoot: string): { name?: string; url?: string } {
  const upstream = gitSafe(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: gitRoot }
  )?.trim();
  const remotes = (gitSafe(["remote"], { cwd: gitRoot }) || "")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  let name: string | undefined;
  if (upstream && upstream.includes("/")) {
    const candidate = upstream.split("/")[0];
    if (remotes.includes(candidate)) name = candidate;
  }
  if (!name && remotes.includes("origin")) name = "origin";
  if (!name) name = remotes[0];
  if (!name) return {};
  const url = gitSafe(["remote", "get-url", name], { cwd: gitRoot })?.trim();
  return { name, url: url ? sanitizeRemoteUrl(url) : undefined };
}

/**
 * Describe the real git repo that contains `cwd`. Returns undefined when cwd
 * is not inside a git repo or the repo has no commits.
 */
export function getRealRepoInfo(cwd: string = process.cwd()): RealRepoInfo | undefined {
  const top = gitSafe(["rev-parse", "--show-toplevel"], { cwd })?.trim();
  if (!top) return undefined;
  const gitRoot = fs.realpathSync(top);
  const headSha = gitSafe(["rev-parse", "HEAD"], { cwd: gitRoot })?.trim();
  if (!headSha) return undefined;
  const branch =
    gitSafe(["branch", "--show-current"], { cwd: gitRoot })?.trim() || "";
  const remote = pickRemote(gitRoot);
  const rel = path.relative(gitRoot, fs.realpathSync(cwd));
  return {
    gitRoot,
    projectSubdir: rel.split(path.sep).join("/"),
    headSha,
    branch,
    remoteUrl: remote.url,
    remoteName: remote.name,
  };
}
