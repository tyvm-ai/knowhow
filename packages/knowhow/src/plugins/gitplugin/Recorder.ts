import * as fs from "fs";
import * as path from "path";
import { GitRunner } from "./GitRunner";
import {
  RecordRequest,
  RecordResult,
  TIMELINE_REF,
  agentLabel,
} from "./types";

const MAX_RETRIES = 80;
let counter = 0;

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function buildMessage(req: RecordRequest): string {
  const label = agentLabel(req.agent);
  const lines = [`[${label}] ${req.kind}: ${req.summary.replace(/\s+/g, " ").slice(0, 200)}`, ""];
  lines.push(`Agent: ${req.agent}`);
  lines.push(`Kind: ${req.kind}`);
  if (req.tool) lines.push(`Tool: ${req.tool}`);
  if (req.cmd) lines.push(`Cmd: ${req.cmd.replace(/\s+/g, " ").slice(0, 200)}`);
  if (req.attribution) lines.push(`Attribution: ${req.attribution}`);
  if (req.alsoPossible?.length) lines.push(`Also-Possible: ${req.alsoPossible.join(",")}`);
  if (req.realHead) lines.push(`Real-HEAD: ${req.realHead}`);
  if (req.bulk) lines.push("Bulk: true");
  for (const [k, v] of Object.entries(req.trailers || {})) lines.push(`${k}: ${v}`);
  return lines.join("\n");
}

/**
 * Lock-free commit on the timeline ref (design §2.3): private index seeded from
 * the tip, only the requested paths are staged, commit-tree, update-ref CAS.
 * Never touches the work tree, HEAD or the default index.
 */
export class Recorder {
  constructor(private git: GitRunner) {}

  tip(): string | null {
    return this.git.tryRun(["rev-parse", "--verify", "-q", `${TIMELINE_REF}^{commit}`]) || null;
  }

  recordChange(req: RecordRequest): RecordResult {
    if (fs.existsSync(path.join(this.git.gitDir, "repair.lock"))) {
      return { sha: null, retries: 0, files: [] };
    }
    const paths = Array.from(new Set(req.paths));
    if (!paths.length) return { sha: null, retries: 0, files: [] };
    const idx = path.join(this.git.gitDir, `idx.${process.pid}.${++counter}`);
    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const tip = this.tip();
        const io = { indexFile: idx };
        if (tip) this.git.run(["read-tree", tip], io);
        else this.git.run(["read-tree", "--empty"], io);
        const flags = req.forceRemove ? ["--force-remove"] : ["--add", "--remove"];
        this.git.run(["update-index", ...flags, "-z", "--stdin"], {
          ...io,
          input: paths.join("\0") + "\0",
        });
        const tree = this.git.run(["write-tree"], io);
        if (tip) {
          const old = this.git.run(["rev-parse", `${tip}^{tree}`]);
          if (old === tree) return { sha: null, retries: attempt, files: [] };
        }
        const label = agentLabel(req.agent);
        const args = ["commit-tree", tree, ...(tip ? ["-p", tip] : []), "-m", buildMessage(req)];
        const sha = this.git.run(args, {
          ...io,
          env: { GIT_AUTHOR_NAME: label, GIT_AUTHOR_EMAIL: "agent@knowhow.local" },
        });
        const cas = this.git.tryRun(["update-ref", "-m", `${req.kind}: ${req.agent}`, TIMELINE_REF, sha, tip || ""]);
        if (cas !== null) {
          const files = tip
            ? this.git
                .run(["diff-tree", "-r", "--name-only", "-z", "--no-renames", tip, sha], { raw: true })
                .split("\0")
                .filter(Boolean)
            : paths;
          return { sha, retries: attempt, files };
        }
        sleepSync(Math.floor(Math.random() * (10 + Math.min(attempt, 20) * 8)));
      }
      throw new Error(`timeline update lost the race ${MAX_RETRIES} times`);
    } finally {
      try {
        fs.rmSync(idx, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
