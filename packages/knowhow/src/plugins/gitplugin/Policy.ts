import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import { IncludeSet } from "./Include";
import { DEFAULT_MAX_FILE_MB, INTERNAL_EXCLUDES, toPosix } from "./types";

/**
 * Which paths may enter the timeline: never `.knowhow/` or `.git/`, never
 * oversize files, never ignored paths (design §12.3 B).
 */
export class Policy {
  constructor(
    private git: GitRunner,
    private root: string,
    private maxFileMb: () => number | undefined,
    readonly include: IncludeSet = new IncludeSet(root, () => undefined)
  ) {}

  get maxBytes(): number {
    const mb = this.maxFileMb();
    return (typeof mb === "number" && mb > 0 ? mb : DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  }

  /** Append INTERNAL_EXCLUDES to the history repo's info/exclude (inside .git only). */
  ensureExcludes(): void {
    const file = path.join(this.git.gitDir, "info", "exclude");
    let cur = "";
    try {
      cur = fs.readFileSync(file, "utf8");
    } catch {
      /* new */
    }
    const have = new Set(cur.split("\n").map((l) => l.trim()));
    const missing = INTERNAL_EXCLUDES.filter((p) => !have.has(p));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prefix = cur.length && !cur.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(file, prefix + missing.join("\n") + "\n");
  }

  /** Convert an absolute or cwd-relative path into a repo-relative posix path, or null if outside. */
  toRel(p: string): string | null {
    if (!p) return null;
    let abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    try {
      abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      /* parent missing: keep as is */
    }
    const rel = toPosix(path.relative(this.root, abs));
    if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
    if (rel === ".git" || rel.startsWith(".git/") || rel === ".knowhow" || rel.startsWith(".knowhow/")) {
      return null;
    }
    return rel;
  }

  isOversize(rel: string): boolean {
    try {
      const st = fs.lstatSync(path.join(this.root, rel));
      return st.isFile() && st.size > this.maxBytes;
    } catch {
      return false; // deleted
    }
  }

  isDirectory(rel: string): boolean {
    try {
      return fs.lstatSync(path.join(this.root, rel)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Paths (of those given) matched by ignore rules, regardless of being tracked. */
  ignoredAmong(paths: string[]): Set<string> {
    if (!paths.length) return new Set();
    // paths covered by gitPlugin.include are deliberately tracked although ignored
    paths = paths.filter((p) => !this.include.isIncluded(p));
    if (!paths.length) return new Set();
    const out = this.git.run(["check-ignore", "--no-index", "-z", "--stdin"], {
      input: paths.join("\0") + "\0",
      allowFail: true, // exit 1 when nothing is ignored
      raw: true,
    });
    return new Set(out.split("\0").filter(Boolean));
  }

  /**
   * Filter candidate paths for recording. `trusted` skips the ignore check
   * (sweep lists come from `ls-files --exclude-standard` already).
   */
  filter(paths: string[], opts: { trusted?: boolean } = {}): { keep: string[]; skippedOversize: string[]; skippedIgnored: string[] } {
    const uniq = Array.from(new Set(paths));
    const skippedOversize: string[] = [];
    let cand: string[] = [];
    for (const p of uniq) {
      if (p === ".knowhow" || p.startsWith(".knowhow/") || p === ".git" || p.startsWith(".git/")) continue;
      if (this.isDirectory(p)) continue;
      if (this.isOversize(p)) {
        skippedOversize.push(p);
        continue;
      }
      cand.push(p);
    }
    let skippedIgnored: string[] = [];
    if (!opts.trusted) {
      const ign = this.ignoredAmong(cand);
      skippedIgnored = cand.filter((p) => ign.has(p));
      cand = cand.filter((p) => !ign.has(p));
    }
    return { keep: cand, skippedOversize, skippedIgnored };
  }
}
