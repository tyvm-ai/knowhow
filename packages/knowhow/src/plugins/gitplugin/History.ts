import { GitRunner } from "./GitRunner";
import { TASK_REF_PREFIX, TIMELINE_REF, TimelineCommit } from "./types";

const SEP = "\x1e";
const FIELD = "\x1f";

export function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^([A-Z][A-Za-z-]+): (.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export interface LogOptions {
  agent?: string;
  limit?: number;
  since?: string; // ref or sha: only commits after it
  path?: string;
  kind?: string;
}

/** Read-only queries over the timeline (design §4.3). */
export class History {
  constructor(private git: GitRunner) {}

  log(opts: LogOptions = {}): TimelineCommit[] {
    const args = ["log", `--format=%H${FIELD}%s${FIELD}%aI${FIELD}%b${SEP}`];
    if (opts.agent) args.push("-E", `--grep=^Agent: ${opts.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    if (opts.limit) args.push(`-n${Math.floor(opts.limit)}`);
    args.push(opts.since ? `${opts.since}..${TIMELINE_REF}` : TIMELINE_REF);
    if (opts.path) args.push("--", opts.path);
    const raw = this.git.tryRun(args, { raw: true });
    if (!raw) return [];
    const commits: TimelineCommit[] = [];
    for (const rec of raw.split(SEP)) {
      const r = rec.replace(/^\n/, "");
      if (!r.trim()) continue;
      const [sha, subject, date, body = ""] = r.split(FIELD);
      const trailers = parseTrailers(body);
      // legacy (V1) fallback: "[taskId] message"
      const legacy = /^\[([^\]]+)\]/.exec(subject || "");
      const agent = trailers.Agent || legacy?.[1] || "unknown";
      commits.push({ sha, subject, agent, kind: trailers.Kind || "legacy", date, trailers });
    }
    return opts.kind ? commits.filter((c) => c.kind === opts.kind) : commits;
  }

  /** Files touched by an agent's commits (union). */
  filesFor(agent: string): string[] {
    const files = new Set<string>();
    for (const c of this.log({ agent })) {
      for (const f of this.git
        .run(["diff-tree", "-r", "--name-only", "--no-commit-id", "-z", "--root", "--no-renames", c.sha], { raw: true })
        .split("\0")
        .filter(Boolean)) {
        files.add(f);
      }
    }
    return Array.from(files).sort();
  }

  /** Net diff of an agent: first-touch parent .. last-touch, per file (design §2.5 common case). */
  diffForAgent(agent: string, filePath?: string): string {
    const commits = this.log({ agent }); // newest first
    if (!commits.length) return "";
    const oldest = commits[commits.length - 1].sha;
    const newest = commits[0].sha;
    const base = this.git.tryRun(["rev-parse", "--verify", "-q", `${oldest}^`]);
    const files = this.filesFor(agent).filter((f) => !filePath || f === filePath);
    if (!files.length) return "";
    const args = ["diff", "--no-color", base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", newest, "--", ...files];
    return this.git.run(args, { raw: true });
  }

  show(sha: string): string {
    return this.git.run(["show", "--stat", "--format=fuller", "--no-color", sha], { raw: true });
  }

  tasks(): { taskId: string; start?: string; end?: string }[] {
    const out = this.git.tryRun(["for-each-ref", "--format=%(refname) %(objectname)", TASK_REF_PREFIX]) || "";
    const map = new Map<string, { taskId: string; start?: string; end?: string }>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      const m = new RegExp(`^${TASK_REF_PREFIX}(.+)/(start|end)$`).exec(ref);
      if (!m) continue;
      const e = map.get(m[1]) || { taskId: m[1] };
      (e as any)[m[2]] = sha;
      map.set(m[1], e);
    }
    return Array.from(map.values());
  }

  formatLine(c: TimelineCommit): string {
    const extra = c.trailers.Attribution === "ambiguous" ? " (ambiguous)" : "";
    return `${c.sha.slice(0, 8)} ${c.date.slice(0, 19)} ${c.subject}${extra}`;
  }
}
