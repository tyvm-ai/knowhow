import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";

/**
 * Shared, shell-free search helpers for textSearch / fileSearch.
 *
 * Everything here passes arguments as arrays to spawn() (never through a
 * shell), uses fixed-string mode, and prefers the fastest backend present:
 *   rg -> git grep (inside a git repo) -> ag -> pure node fallback.
 */

/** Directory names skipped by default (matched anywhere in the path). */
export const DEFAULT_EXCLUDE_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "coverage",
  "Pods",
];
/** File globs skipped by default. */
export const DEFAULT_EXCLUDE_FILE_GLOBS = ["*.min.js", "*.min.css", "*.map"];
/** android/build is covered by the `build` dir exclude; listed for docs. */
export const DEFAULT_EXCLUDES_DESCRIPTION =
  "node_modules, dist, build (incl. android/build), .git, .next, coverage, Pods, *.min.js";

export const DEFAULT_SEARCH_TIMEOUT_MS = Number(
  process.env.KNOWHOW_SEARCH_TIMEOUT_MS || 60_000
);
/** Stop reading backend output after this many raw lines. */
export const MAX_RAW_LINES = 5000;
/** Stop reading backend output after this many bytes. */
export const MAX_RAW_BYTES = 8 * 1024 * 1024;

export type SearchBackend = "rg" | "git grep" | "ag" | "node";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The binary was not found. */
  missing: boolean;
  timedOut: boolean;
  /** We killed the process because output got too large. */
  truncated: boolean;
}

/**
 * Run a binary with an args array (no shell). Collects stdout until a line/byte
 * limit is reached, then kills the child and reports `truncated`.
 */
export function runBinary(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    maxLines?: number;
    maxBytes?: number;
  } = {}
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const maxLines = opts.maxLines ?? MAX_RAW_LINES;
  const maxBytes = opts.maxBytes ?? MAX_RAW_BYTES;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let lines = 0;
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let missing = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      resolve({
        stdout,
        stderr: e?.message || String(e),
        code: null,
        missing: true,
        timedOut,
        truncated,
      });
      return;
    }

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, missing, timedOut, truncated });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const text = chunk.toString("utf8");
      bytes += chunk.length;
      stdout += text;
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") lines++;
      if (lines >= maxLines || bytes >= maxBytes) {
        truncated = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") missing = true;
      stderr += err.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

const availability = new Map<string, Promise<boolean>>();
/** Cached check that a binary exists on PATH. */
export function hasBinary(cmd: string): Promise<boolean> {
  if (!availability.has(cmd)) {
    availability.set(
      cmd,
      runBinary(cmd, ["--version"], { timeoutMs: 5000, maxLines: 5 }).then(
        (r) => !r.missing
      )
    );
  }
  return availability.get(cmd)!;
}

/** Test hook: forget cached availability. */
export function resetBackendCache() {
  availability.clear();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!(await hasBinary("git"))) return false;
  const r = await runBinary("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: 5000,
    maxLines: 5,
  });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** True when the user explicitly pointed into an excluded dir (e.g. node_modules/foo). */
export function pathTargetsExcludedDir(target?: string): boolean {
  if (!target) return false;
  const segs = target.split(/[\\/]+/);
  return segs.some((s) => DEFAULT_EXCLUDE_DIRS.includes(s));
}

export function isExcludedPath(relPath: string): boolean {
  const segs = relPath.split(/[\\/]+/);
  if (segs.slice(0, -1).some((s) => DEFAULT_EXCLUDE_DIRS.includes(s))) {
    return true;
  }
  const base = segs[segs.length - 1];
  return DEFAULT_EXCLUDE_FILE_GLOBS.some((g) => minimatch(base, g));
}

/** Directory name -> should the node walker descend into it. */
export function isExcludedDirName(name: string): boolean {
  return DEFAULT_EXCLUDE_DIRS.includes(name);
}

export interface WalkOptions {
  root: string;
  /** Keep default excludes (default true). */
  useDefaultExcludes?: boolean;
  maxFiles?: number;
  deadline?: number;
}

/** Pure-node recursive file lister (relative paths to cwd of root). Honors root .gitignore only trivially via default excludes. */
export function walkFiles(opts: WalkOptions): { files: string[]; truncated: boolean } {
  const { root } = opts;
  const useDefaults = opts.useDefaultExcludes !== false;
  const maxFiles = opts.maxFiles ?? 200_000;
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length) {
    if (opts.deadline && Date.now() > opts.deadline) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (useDefaults && isExcludedDirName(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (
          useDefaults &&
          DEFAULT_EXCLUDE_FILE_GLOBS.some((g) => minimatch(entry.name, g))
        ) {
          continue;
        }
        files.push(full);
        if (files.length >= maxFiles) return { files, truncated: true };
      }
    }
  }
  return { files, truncated };
}

/** Convert a user term to a case-insensitive regex: `*` and `?` are wildcards, everything else literal. */
export function fileTermToRegExp(term: string): RegExp {
  let src = "";
  for (const ch of term) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
  }
  return new RegExp(src, "i");
}

/**
 * List files (relative to cwd) using the fastest backend available:
 * rg --files -> git ls-files -> node walk. All respect default excludes.
 */
export async function listFiles(
  cwd: string,
  target: string | undefined,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS
): Promise<{ files: string[]; backend: SearchBackend; truncated: boolean }> {
  const useDefaults = !pathTargetsExcludedDir(target);
  const scope = target && target !== "." ? target : undefined;

  if (await hasBinary("rg")) {
    const args = ["--files", "--color", "never", "--hidden"];
    if (useDefaults) {
      for (const d of DEFAULT_EXCLUDE_DIRS) args.push("--glob", `!**/${d}/**`);
      for (const g of DEFAULT_EXCLUDE_FILE_GLOBS) args.push("--glob", `!${g}`);
    }
    args.push("--", scope || ".");
    const r = await runBinary("rg", args, {
      cwd,
      timeoutMs,
      maxLines: 500_000,
      maxBytes: 64 * 1024 * 1024,
    });
    if (!r.missing && (r.code === 0 || r.code === 1 || r.truncated || r.timedOut)) {
      return {
        files: r.stdout.split("\n").filter(Boolean).map(stripDotSlash),
        backend: "rg",
        truncated: r.truncated || r.timedOut,
      };
    }
  }

  if (await isGitRepo(cwd)) {
    const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
    if (scope) args.push("--", scope);
    const r = await runBinary("git", args, {
      cwd,
      timeoutMs,
      maxLines: 500_000,
      maxBytes: 64 * 1024 * 1024,
    });
    if (!r.missing && (r.code === 0 || r.truncated || r.timedOut)) {
      let files = r.stdout.split("\n").filter(Boolean);
      if (useDefaults) files = files.filter((f) => !isExcludedPath(f));
      return { files, backend: "git grep", truncated: r.truncated || r.timedOut };
    }
  }

  const walked = walkFiles({
    root: path.resolve(cwd, scope || "."),
    useDefaultExcludes: useDefaults,
    deadline: Date.now() + timeoutMs,
  });
  return {
    files: walked.files.map((f) => path.relative(cwd, f)),
    backend: "node",
    truncated: walked.truncated,
  };
}

export function stripDotSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}
