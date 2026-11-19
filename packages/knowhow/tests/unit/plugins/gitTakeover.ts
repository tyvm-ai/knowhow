import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { GitPlugin } from "../../../src/plugins/GitPlugin";
import { EventService } from "../../../src/services/EventService";
import { manifest, diffManifest, write } from "./gitHelpers";

const g = (gitDir: string, args: string[], input?: string) =>
  execFileSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8", input, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

const sha1 = (f: string) => {
  try { return crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex"); } catch { return "absent"; }
};

/** Legacy-visible state of a history repo: HEAD file, default index bytes, every ref except timeline and refs/knowhow. */
export function legacyState(gitDir: string) {
  let refs = "";
  try {
    refs = g(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"])
      .split("\n").filter((l) => l && !l.startsWith("refs/heads/timeline ") && !l.startsWith("refs/knowhow/")).join("\n");
  } catch { /* no repo */ }
  return {
    head: fs.existsSync(path.join(gitDir, "HEAD")) ? fs.readFileSync(path.join(gitDir, "HEAD"), "utf8") : "missing",
    index: sha1(path.join(gitDir, "index")),
    refs,
    lock: fs.existsSync(path.join(gitDir, "index.lock")),
  };
}

export interface TakeoverResult {
  workTreeChanged: string[];
  legacyChanged: string[];
  seeded: boolean;
  recorded: boolean;
  swept: boolean;
  timelineOk: boolean;
  fsckAll: string;
  ms: { start: number; record: number; sweep: number };
  tipBefore: string | null;
}

/**
 * Run a V2 takeover of `root` (cwd is switched to it): start, one agent edit (written by the harness),
 * an unowned edit + sweep, then verify nothing V1 can see changed and the timeline is healthy.
 */
export async function takeover(root: string, skipDirs: string[] = []): Promise<TakeoverResult> {
  const gitDir = path.join(root, ".knowhow", ".git");
  const prev = process.cwd();
  process.chdir(root);
  try {
    const mBefore = manifest(root, skipDirs);
    const lBefore = legacyState(gitDir);
    const events = new EventService();
    const plugin = new GitPlugin({ Events: events } as any);
    plugin.enable();
    let t = Date.now();
    const ok = plugin.ensureStarted();
    const start = Date.now() - t;
    if (!ok) throw new Error("V2 did not start");
    events.emit("agent:newTask", { taskId: "cert-A" });
    const tipBefore = plugin.core.recorder.tip();
    // the harness writes these on purpose: exclude them from the "unchanged" comparison
    write(root, "v2-cert/edit.txt", "edit\n");
    t = Date.now();
    await events.emitBlocking("file:post-edit", { filePath: path.join(root, "v2-cert/edit.txt"), taskId: "cert-A", operation: "write" });
    const record = Date.now() - t;
    const recorded = plugin.core.history.log({ agent: "cert-A" }).length === 1;
    write(root, "v2-cert/other.txt", "other\n");
    t = Date.now();
    const sw = plugin.core.sweeper.sweep();
    const sweep = Date.now() - t;
    events.emit("agent:taskComplete", { taskId: "cert-A" });
    const swept = sw.swept.includes("v2-cert/other.txt");

    const mAfter = manifest(root, skipDirs);
    const workTreeChanged = diffManifest(mBefore, mAfter).filter((p) => !p.startsWith("v2-cert/"));
    const lAfter = legacyState(gitDir);
    const legacyChanged = (Object.keys(lBefore) as (keyof typeof lBefore)[]).filter((k) => lBefore[k] !== lAfter[k]);
    let timelineOk = true;
    try { g(gitDir, ["rev-list", "--objects", "--quiet", "refs/heads/timeline"]); } catch { timelineOk = false; }
    let fsckAll = "";
    try { fsckAll = execFileSync("git", ["--git-dir", gitDir, "fsck", "--connectivity-only", "--no-dangling"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e: any) { fsckAll = String(e.stderr || e.message).slice(0, 400); }
    return {
      workTreeChanged, legacyChanged,
      seeded: !!plugin.core.recorder.tip(), recorded, swept, timelineOk,
      fsckAll: fsckAll.trim(), ms: { start, record, sweep }, tipBefore,
    };
  } finally {
    process.chdir(prev);
  }
}
