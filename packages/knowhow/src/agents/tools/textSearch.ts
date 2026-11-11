import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_FILE_GLOBS,
  DEFAULT_EXCLUDES_DESCRIPTION,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_RAW_LINES,
  RunResult,
  SearchBackend,
  hasBinary,
  isExcludedPath,
  isGitRepo,
  pathTargetsExcludedDir,
  runBinary,
  stripDotSlash,
  walkFiles,
} from "./searchBackends";

export { DEFAULT_EXCLUDES_DESCRIPTION };

// Max number of matching lines (with full text) we show per file before we
// summarize the rest as a list of line numbers.
const PER_FILE_LINE_LIMIT = 5;
/** Default cap on matching lines shown across all files. */
export const DEFAULT_MAX_RESULTS = 200;
/** Cap on the size of the formatted output. */
export const MAX_OUTPUT_CHARS = 30_000;
const MAX_LINE_CHARS = 300;

export interface FileMatches {
  file: string;
  // [lineNumber, lineText]
  lines: Array<[number, string]>;
}

/**
 * Parse `file:line:text` output (rg --no-heading, git grep -n, ag --nogroup)
 * into per-file match groups, preserving first-seen file order.
 */
export function parseFlatOutput(stdout: string): FileMatches[] {
  const byFile = new Map<string, FileMatches>();
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const m = raw.match(/^(.+?):(\d+):([\s\S]*)$/);
    if (!m) continue;
    const file = stripDotSlash(m[1]);
    let entry = byFile.get(file);
    if (!entry) {
      entry = { file, lines: [] };
      byFile.set(file, entry);
    }
    entry.lines.push([Number(m[2]), m[3]]);
  }
  return [...byFile.values()];
}

function clip(text: string): string {
  const trimmed = text.replace(/\r$/, "");
  return trimmed.length > MAX_LINE_CHARS
    ? trimmed.slice(0, MAX_LINE_CHARS) + "…"
    : trimmed;
}

/**
 * Format the parsed matches into a readable, capped report: total counts,
 * line numbers beyond the per-file limit, and a summary of everything cut by
 * the global caps.
 */
export function formatMatches(
  files: FileMatches[],
  opts: { maxResults?: number; atLeast?: boolean } = {}
): string {
  if (files.length === 0) return "No matches found.";
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;

  const totalMatches = files.reduce((n, f) => n + f.lines.length, 0);
  const sections: string[] = [];
  let shownLines = 0;
  let shownChars = 0;
  let shownFiles = 0;

  for (const { file, lines } of files) {
    if (shownLines >= maxResults || shownChars >= MAX_OUTPUT_CHARS) break;
    const total = lines.length;
    const room = Math.max(0, maxResults - shownLines);
    const shown = lines.slice(0, Math.min(PER_FILE_LINE_LIMIT, room));

    const header = `${file} (${total} match${total === 1 ? "" : "es"})`;
    const body = shown.map(([num, text]) => `${num}:${clip(text)}`).join("\n");
    let section = `${header}\n${body}`;

    if (total > shown.length) {
      const remaining = lines.slice(shown.length);
      const nums = remaining.slice(0, 50).map(([num]) => num);
      section +=
        `\n... ${remaining.length} more match${
          remaining.length === 1 ? "" : "es"
        } in this file. Remaining matches on lines: [${nums.join(", ")}${
          remaining.length > nums.length ? ", ..." : ""
        }]`;
    }

    sections.push(section);
    shownLines += shown.length;
    shownChars += section.length;
    shownFiles++;
  }

  let out = sections.join("\n\n");
  const hiddenFiles = files.length - shownFiles;
  if (hiddenFiles > 0) {
    const hiddenMatches = files
      .slice(shownFiles)
      .reduce((n, f) => n + f.lines.length, 0);
    out +=
      `\n\n[output capped: ${hiddenMatches}${opts.atLeast ? "+" : ""} more matches in ${hiddenFiles} more file${
        hiddenFiles === 1 ? "" : "s"
      } not shown. Narrow the search term or pass a path/glob.]`;
  } else if (opts.atLeast) {
    out +=
      `\n\n[search stopped after ${MAX_RAW_LINES} matches; there may be more. Narrow the search term or pass a path/glob.]`;
  }
  return out;
}

interface SearchRequest {
  term: string;
  cwd: string;
  target?: string;
  glob?: string;
  timeoutMs: number;
}

interface BackendOutcome {
  backend: SearchBackend;
  /** Raw `file:line:text` stdout. */
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Search term sanitation: backends are line-oriented, so use the first non-empty line. */
export function normalizeSearchTerm(raw: unknown): {
  term: string;
  note?: string;
} {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  if (!text.includes("\n")) return { term: text };
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const first = lines[0] ?? "";
  return {
    term: first,
    note:
      lines.length > 1
        ? `Search term had ${lines.length} lines; searches are line-based so only the first line was used: ${JSON.stringify(first.slice(0, 80))}`
        : undefined,
  };
}

function usable(r: RunResult, okCodes: number[]): boolean {
  if (r.missing) return false;
  if (r.truncated || r.timedOut) return true;
  return r.code !== null && okCodes.includes(r.code);
}

function toOutcome(backend: SearchBackend, r: RunResult): BackendOutcome {
  return {
    backend,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: r.truncated,
    timedOut: r.timedOut,
  };
}

async function searchWithRg(req: SearchRequest): Promise<BackendOutcome | null> {
  if (!(await hasBinary("rg"))) return null;
  const args = [
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color",
    "never",
    "--fixed-strings",
    "--max-columns",
    String(MAX_LINE_CHARS),
    "--max-columns-preview",
    "--max-filesize",
    "5M",
  ];
  if (!pathTargetsExcludedDir(req.target)) {
    for (const d of DEFAULT_EXCLUDE_DIRS) args.push("--glob", `!**/${d}/**`);
    for (const g of DEFAULT_EXCLUDE_FILE_GLOBS) args.push("--glob", `!${g}`);
  }
  if (req.glob) args.push("--glob", req.glob);
  args.push("-e", req.term, "--", req.target || ".");
  const r = await runBinary("rg", args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
  });
  // rg: 0 = matches, 1 = none, 2 = error (partial results possible)
  if (!usable(r, [0, 1]) && !(r.code === 2 && r.stdout.trim())) return null;
  return toOutcome("rg", r);
}

async function searchWithGitGrep(req: SearchRequest): Promise<BackendOutcome | null> {
  if (!(await isGitRepo(req.cwd))) return null;
  const args = [
    "grep",
    "--line-number",
    "--no-color",
    "-I",
    "--fixed-strings",
    "--untracked",
    "-e",
    req.term,
    "--",
  ];
  const pathspecs: string[] = [];
  if (req.target && req.target !== ".") pathspecs.push(req.target);
  if (req.glob) pathspecs.push(`:(glob)${req.glob.includes("/") ? req.glob : `**/${req.glob}`}`);
  if (!pathTargetsExcludedDir(req.target)) {
    for (const d of DEFAULT_EXCLUDE_DIRS) pathspecs.push(`:(exclude,glob)**/${d}/**`);
    for (const g of DEFAULT_EXCLUDE_FILE_GLOBS) pathspecs.push(`:(exclude,glob)**/${g}`);
  }
  // A pathspec list of only excludes selects nothing; add "." as the positive spec.
  if (!pathspecs.some((p) => !p.startsWith(":(exclude"))) pathspecs.unshift(".");
  args.push(...pathspecs);
  const r = await runBinary("git", args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
  });
  if (!usable(r, [0, 1])) return null;
  return toOutcome("git grep", r);
}

async function searchWithAg(req: SearchRequest): Promise<BackendOutcome | null> {
  if (!(await hasBinary("ag"))) return null;
  const args = ["--nogroup", "--numbers", "--nocolor", "--literal", "--silent"];
  if (!pathTargetsExcludedDir(req.target)) {
    for (const d of DEFAULT_EXCLUDE_DIRS) args.push("--ignore", d);
    for (const g of DEFAULT_EXCLUDE_FILE_GLOBS) args.push("--ignore", g);
  }
  args.push("--", req.term, req.target || ".");
  const r = await runBinary("ag", args, {
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
  });
  if (!usable(r, [0, 1])) return null;
  const outcome = toOutcome("ag", r);
  if (req.glob) outcome.stdout = filterByGlob(outcome.stdout, req.glob);
  return outcome;
}

/** Keep only `file:line:text` rows whose file matches `glob` (basename match when no slash). */
function filterByGlob(stdout: string, glob: string): string {
  return stdout
    .split("\n")
    .filter((row) => {
      const m = row.match(/^(.+?):\d+:/);
      if (!m) return false;
      return minimatch(stripDotSlash(m[1]), glob, { matchBase: !glob.includes("/") });
    })
    .join("\n");
}

function searchWithNode(req: SearchRequest): BackendOutcome {
  const deadline = Date.now() + req.timeoutMs;
  const abs = path.resolve(req.cwd, req.target || ".");
  const useDefaults = !pathTargetsExcludedDir(req.target);
  let candidates: string[];
  let walkTruncated = false;
  try {
    if (fs.statSync(abs).isFile()) candidates = [abs];
    else {
      const walked = walkFiles({ root: abs, useDefaultExcludes: useDefaults, deadline });
      candidates = walked.files;
      walkTruncated = walked.truncated;
    }
  } catch (e: any) {
    return {
      backend: "node",
      stdout: "",
      stderr: `Cannot search ${req.target || "."}: ${e.message}`,
      truncated: false,
      timedOut: false,
    };
  }

  const rows: string[] = [];
  let truncated = walkTruncated;
  for (const file of candidates) {
    if (rows.length >= MAX_RAW_LINES || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const rel = path.relative(req.cwd, file);
    if (req.glob && !minimatch(rel, req.glob, { matchBase: !req.glob.includes("/") })) continue;
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 5 * 1024 * 1024) continue;
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    if (!text.includes(req.term)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(req.term)) rows.push(`${rel}:${i + 1}:${lines[i]}`);
    }
  }
  return {
    backend: "node",
    stdout: rows.join("\n"),
    stderr: "",
    truncated,
    timedOut: false,
  };
}

/**
 * Literal-safe text search. The term is passed as a fixed string via an argument
 * array (no shell), so quotes, `$`, brackets, `|`, `(` and leading `-` all work.
 *
 * Backends, fastest first: rg -> git grep -> ag -> node. Default excludes:
 * node_modules, dist, build, .git, .next, coverage, Pods, *.min.js.
 */
export async function textSearch(
  searchTerm: string,
  searchPath?: string,
  glob?: string,
  maxResults?: number | string
) {
  const { term, note } = normalizeSearchTerm(searchTerm);
  if (!term.trim()) {
    return { stdout: "", stderr: "searchTerm is empty." };
  }
  const cap = Number(maxResults);
  const req: SearchRequest = {
    term,
    cwd: process.cwd(),
    target: searchPath && String(searchPath).trim() ? String(searchPath).trim() : undefined,
    glob: glob && String(glob).trim() ? String(glob).trim() : undefined,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  };

  // KNOWHOW_SEARCH_BACKENDS (comma list of rg,git grep,ag,node) restricts/reorders
  // backends; used by tests and as an escape hatch if one misbehaves.
  const allowed = (process.env.KNOWHOW_SEARCH_BACKENDS || "rg,git grep,ag,node")
    .split(",")
    .map((b) => b.trim());
  let outcome: BackendOutcome | null = null;
  for (const name of allowed) {
    if (name === "rg") outcome = await searchWithRg(req);
    else if (name === "git grep") outcome = await searchWithGitGrep(req);
    else if (name === "ag") outcome = await searchWithAg(req);
    else if (name === "node") outcome = searchWithNode(req);
    if (outcome) break;
  }
  if (!outcome) outcome = searchWithNode(req);

  let files = parseFlatOutput(outcome.stdout);
  // git grep / node don't know about every default exclude (e.g. nested names): enforce.
  if (!pathTargetsExcludedDir(req.target)) {
    files = files.filter((f) => !isExcludedPath(f.file));
  }

  let formatted = formatMatches(files, {
    maxResults: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_RESULTS,
    atLeast: outcome.truncated,
  });
  if (outcome.timedOut) {
    formatted += `\n\n[search timed out after ${req.timeoutMs}ms using ${outcome.backend}; results are partial. Pass a path or glob to narrow it.]`;
  }
  const notes = [note, `[searched with ${outcome.backend}; excluded: ${DEFAULT_EXCLUDES_DESCRIPTION}]`]
    .filter(Boolean)
    .join("\n");

  return {
    stdout: `${formatted}\n\n${notes}`,
    stderr: files.length === 0 ? outcome.stderr.trim() : "",
  };
}
