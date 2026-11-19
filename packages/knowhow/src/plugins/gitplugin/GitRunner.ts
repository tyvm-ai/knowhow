import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The ONE place GitPlugin talks to git. Invariant #1 of the design (§12.3 A):
 * the plugin never creates, modifies or deletes a file in the work tree. Only
 * plumbing/read-only subcommands are allowed, and a few flags that make a
 * subcommand write the work tree are rejected before git is spawned.
 */
export const ALLOWED_SUBCOMMANDS = new Set([
  "rev-parse", "cat-file", "hash-object", "read-tree", "update-index",
  "write-tree", "commit-tree", "update-ref", "symbolic-ref", "for-each-ref",
  "log", "rev-list", "diff", "diff-tree", "diff-index", "ls-files", "ls-tree",
  "status", "check-ignore", "merge-tree", "merge-file", "notes", "fsck", "gc",
  "count-objects", "init", "config", "show", "mktree", "merge-base", "diff-files",
  "show-ref", "pack-refs", "prune", "repack",
]);

/** Flags that turn an otherwise harmless subcommand into a work tree writer. */
const FORBIDDEN_FLAGS: Record<string, string[]> = {
  "read-tree": ["-u", "-m", "--reset", "--merge", "--prefix"],
  "merge-file": [], // handled below (needs -p / --stdout)
  gc: [],
};

export class GitSafetyError extends Error {}

export function assertAllowed(args: string[]): void {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) {
    throw new GitSafetyError(`git: global options/empty command are not allowed (${args.join(" ")})`);
  }
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new GitSafetyError(`git ${sub} is not allowed: GitPlugin never writes the work tree`);
  }
  const bad = FORBIDDEN_FLAGS[sub] || [];
  for (const a of args.slice(1)) {
    if (a === "--") break;
    if (bad.includes(a) || bad.some((b) => b.startsWith("--") && a.startsWith(b + "="))) {
      throw new GitSafetyError(`git ${sub} ${a} is not allowed: it writes the work tree`);
    }
  }
  if (sub === "merge-file" && !args.includes("-p") && !args.includes("--stdout")) {
    throw new GitSafetyError("git merge-file without -p would overwrite a file");
  }
  if (sub === "diff" && args.some((a) => a === "--output" || a.startsWith("--output="))) {
    throw new GitSafetyError("git diff --output is not allowed");
  }
}

export interface RunOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  /** private index to use; default is a scratch index, never the default `index` */
  indexFile?: string;
  timeoutMs?: number;
  allowFail?: boolean;
  /** return Buffer-decoded string without trimming */
  raw?: boolean;
}

export class GitRunner {
  readonly gitDir: string;
  readonly workTree: string;
  private baseEnv?: NodeJS.ProcessEnv;
  private scratchIndex: string;
  spawnCount = 0;

  constructor(gitDir: string, workTree: string) {
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.scratchIndex = path.join(gitDir, `idx.scratch.${process.pid}`);
  }

  private env(extra?: Record<string, string>, indexFile?: string): NodeJS.ProcessEnv {
    if (!this.baseEnv) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.GIT_INDEX_FILE;
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      env.GIT_OPTIONAL_LOCKS = "0";
      env.GIT_TERMINAL_PROMPT = "0";
      env.GIT_AUTHOR_NAME ||= "knowhow";
      env.GIT_AUTHOR_EMAIL ||= "knowhow@localhost";
      env.GIT_COMMITTER_NAME ||= "knowhow";
      env.GIT_COMMITTER_EMAIL ||= "knowhow@localhost";
      this.baseEnv = env;
    }
    return {
      ...this.baseEnv,
      ...(extra || {}),
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      GIT_INDEX_FILE: indexFile || this.scratchIndex,
    };
  }

  /** Run an allow-listed git command. Returns stdout (trimmed unless raw). Throws on failure unless allowFail. */
  run(args: string[], opts: RunOptions = {}): string {
    assertAllowed(args);
    this.spawnCount++;
    try {
      const out = execFileSync("git", args, {
        cwd: this.workTree,
        env: this.env(opts.env, opts.indexFile),
        input: opts.input,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 512 * 1024 * 1024,
        timeout: opts.timeoutMs,
      }).toString();
      return opts.raw ? out : out.trim();
    } catch (e: any) {
      if (opts.allowFail) return "";
      const stderr = e.stderr ? e.stderr.toString() : e.message;
      const err: any = new Error(`git ${args.slice(0, 4).join(" ")} failed: ${stderr.trim().slice(0, 500)}`);
      err.status = e.status;
      err.stderr = stderr;
      throw err;
    }
  }

  /**
   * Start an allow-listed command (gc) in the background and return at once; output is discarded.
   * Used by automatic maintenance so an agent's start never waits for a repack.
   */
  runDetached(args: string[]): number | undefined {
    assertAllowed(args);
    this.spawnCount++;
    try {
      const cp = spawn("git", args, { cwd: this.workTree, env: this.env(), detached: true, stdio: "ignore" });
      cp.on("error", () => { /* git missing or repo gone: nothing to do */ });
      cp.unref();
      return cp.pid;
    } catch {
      return undefined;
    }
  }

  /** Like run() but returns the raw stdout bytes (blob contents, merge-file output). Throws on failure. */
  runBuffer(args: string[], opts: RunOptions = {}): Buffer {
    assertAllowed(args);
    this.spawnCount++;
    try {
      return execFileSync("git", args, {
        cwd: this.workTree,
        env: this.env(opts.env, opts.indexFile),
        input: opts.input,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 1024,
        timeout: opts.timeoutMs,
      });
    } catch (e: any) {
      // merge-file exits with the number of conflicts (>0) but still prints the merge on stdout
      if (opts.allowFail && e?.stdout) return e.stdout as Buffer;
      const stderr = e.stderr ? e.stderr.toString() : e.message;
      const err: any = new Error(`git ${args.slice(0, 4).join(" ")} failed: ${stderr.trim().slice(0, 500)}`);
      err.status = e.status;
      throw err;
    }
  }

  /** Like runBuffer() but never throws on a non-zero exit: returns stdout and the exit status (merge-file: conflict count). */
  runBufferEx(args: string[], opts: RunOptions = {}): { out: Buffer; status: number } {
    assertAllowed(args);
    this.spawnCount++;
    try {
      const out = execFileSync("git", args, {
        cwd: this.workTree,
        env: this.env(opts.env, opts.indexFile),
        input: opts.input,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 1024,
        timeout: opts.timeoutMs,
      });
      return { out, status: 0 };
    } catch (e: any) {
      return { out: (e?.stdout as Buffer) || Buffer.alloc(0), status: typeof e?.status === "number" ? e.status : 255 };
    }
  }

  /** Like run() but returns null instead of throwing. */
  tryRun(args: string[], opts: RunOptions = {}): string | null {
    try {
      return this.run(args, opts);
    } catch {
      return null;
    }
  }

  /** Split NUL separated output. */
  runZ(args: string[], opts: RunOptions = {}): string[] {
    return this.run(args, { ...opts, raw: true }).split("\0").filter(Boolean);
  }

  dispose(): void {
    try {
      fs.rmSync(this.scratchIndex, { force: true });
    } catch {
      /* ignore */
    }
  }
}
