import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { GitPlugin } from "../../../src/plugins/GitPlugin";
import { EventService } from "../../../src/services/EventService";

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

export const write = (root: string, rel: string, content: string | Buffer) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A temp project with a real git repo (one commit) and cwd moved into it. */
export function makeProject(prefix = "gv2-") {
  const prevCwd = process.cwd();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  sh(root, "init", "-q");
  write(root, ".gitignore", "node_modules\n.knowhow\n");
  write(root, "README.md", "hello\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");
  process.chdir(root);
  return {
    root,
    gitDir: path.join(root, ".knowhow", ".git"),
    cleanup() {
      process.chdir(prevCwd);
      // a detached `gc --auto` from automatic maintenance may still be writing into .knowhow/.git
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

export function newPlugin(events = new EventService()) {
  const plugin = new GitPlugin({ Events: events } as any);
  plugin.enable();
  return { plugin, events };
}

/** git against the history repo (read-only use in tests). */
export const hist = (root: string, ...args: string[]) =>
  execFileSync("git", ["--git-dir", path.join(root, ".knowhow", ".git"), ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();

export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  sha1?: string;
}

/** path -> {size, mtime, sha1} for every file outside .knowhow/ and .git/. */
export function manifest(root: string, skipDirs: string[] = []): Record<string, ManifestEntry> {
  const out: Record<string, ManifestEntry> = {};
  const walk = (dir: string, rel: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (r === ".knowhow" || r === ".git" || skipDirs.includes(r)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) {
        const st = fs.statSync(abs);
        const e: ManifestEntry = { size: st.size, mtimeMs: st.mtimeMs };
        if (st.size < 30 * 1024 * 1024) {
          e.sha1 = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
        }
        out[r] = e;
      }
    }
  };
  walk(root, "");
  return out;
}

export function diffManifest(a: Record<string, ManifestEntry>, b: Record<string, ManifestEntry>): string[] {
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    if (!x || !y || x.size !== y.size || x.mtimeMs !== y.mtimeMs || x.sha1 !== y.sha1) changed.push(k);
  }
  return changed.sort();
}

/** Simulate what the agent tools do: write the file, then emit file:post-edit. */
export async function agentEdit(events: EventService, root: string, taskId: string, rel: string, content: string) {
  write(root, rel, content);
  await events.emitBlocking("file:post-edit", {
    filePath: path.join(root, rel),
    taskId,
    operation: "write",
  });
}
