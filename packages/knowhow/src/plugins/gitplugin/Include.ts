import * as fs from "fs";
import * as path from "path";

/** Never tracked, even inside an included path: secrets, deps, git and our own state (same list as INTERNAL_EXCLUDES). */
export function isSecretPath(rel: string): boolean {
  const segs = rel.split("/");
  if (segs.some((s) => s === "node_modules" || s === ".git" || s === ".knowhow")) return true;
  const base = segs[segs.length - 1];
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".pem") || base.endsWith(".key");
}

const MAX_WALK_FILES = 50_000;

interface Compiled {
  raw: string;
  re: RegExp;
  /** static directory/file prefix (no glob chars), "" = project root */
  prefix: string;
}

function compile(pattern: string): Compiled | null {
  let p = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!p || p.split("/").includes("..") || path.isAbsolute(pattern)) return null;
  if (p.endsWith("/")) p += "**";
  const segs = p.split("/");
  const firstGlob = segs.findIndex((s) => /[*?]/.test(s));
  const prefix = (firstGlob === -1 ? segs : segs.slice(0, firstGlob)).join("/");
  const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let body = esc(p).replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  // a plain path (no glob) also matches everything beneath it
  const hasGlob = firstGlob !== -1;
  const re = new RegExp(hasGlob ? `^${body}$` : `^${body}(/.*)?$`);
  return { raw: pattern, re, prefix };
}

/**
 * `gitPlugin.include`: paths that stay tracked although the project's ignore rules ignore them
 * (for example `scripts/tmp/**`, `data/generator/`). Enumerated by walking only the listed roots,
 * never by listing every ignored file (node_modules). Size cap and secret filter still apply.
 */
export class IncludeSet {
  private compiled: Compiled[] = [];
  private key = "";

  constructor(private root: string, private patterns: () => string[] | undefined) {}

  private refresh(): Compiled[] {
    const pats = (this.patterns() || []).filter((p) => typeof p === "string");
    const key = pats.join("\n");
    if (key !== this.key) {
      this.key = key;
      this.compiled = pats.map(compile).filter((c): c is Compiled => !!c);
    }
    return this.compiled;
  }

  get enabled(): boolean {
    return this.refresh().length > 0;
  }

  /** Literal pathspecs of the static roots, for `ls-files` of the tracked part. */
  roots(): string[] {
    return Array.from(new Set(this.refresh().map((c) => c.prefix))).filter((r) => r !== "");
  }

  /** True when `rel` is covered by an include pattern and is not a secret/dependency/internal path. */
  isIncluded(rel: string): boolean {
    const cs = this.refresh();
    if (!cs.length || isSecretPath(rel)) return false;
    return cs.some((c) => c.re.test(rel));
  }

  /** Every regular file under the include roots that matches a pattern (symlinks and secret paths skipped). */
  walk(): string[] {
    const cs = this.refresh();
    if (!cs.length) return [];
    const out = new Set<string>();
    const visit = (rel: string) => {
      if (out.size >= MAX_WALK_FILES) return;
      const abs = path.join(this.root, rel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        const name = path.basename(rel);
        if (name === "node_modules" || name === ".git" || name === ".knowhow") return;
        let names: string[] = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          return;
        }
        for (const n of names) visit(rel ? `${rel}/${n}` : n);
      } else if (st.isFile()) {
        if (!isSecretPath(rel) && cs.some((c) => c.re.test(rel))) out.add(rel);
      }
    };
    for (const prefix of new Set(cs.map((c) => c.prefix))) visit(prefix);
    return Array.from(out).sort();
  }
}
