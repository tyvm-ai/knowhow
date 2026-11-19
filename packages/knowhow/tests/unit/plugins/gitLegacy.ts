import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { execFileSync, spawn } from "child_process";
import { LegacyV1GitPlugin } from "./legacyV1GitPlugin.fixture";
import { EventService } from "../../../src/services/EventService";
import { makeProject, newPlugin, write, agentEdit } from "./gitHelpers";

/** Frozen copy of the old V1 plugin (legacyV1GitPlugin.fixture.ts) with deterministic (awaitable) access to its private handlers. */
export function newV1() {
  (LegacyV1GitPlugin as any).isListening = false;
  (LegacyV1GitPlugin as any).excludesReady.clear();
  const events = new EventService();
  const v1: any = new LegacyV1GitPlugin({ Events: events } as any);
  v1.enable();
  return {
    v1: v1 as LegacyV1GitPlugin,
    start: async (taskId: string) => {
      await v1.ensureCleanState({ taskId });
      await v1.handleNewTask({ taskId, description: `task ${taskId}` });
    },
    edit: async (rel: string, content: string, root: string) => {
      write(root, rel, content);
      await v1.autoCommit({ filePath: path.join(root, rel), operation: "write" });
    },
    complete: async (taskId: string) => v1.handleTaskComplete({ taskId, answer: "done" }),
    resume: async (branch: string) => v1.setBranch(branch),
  };
}

const gitq = (gitDir: string, args: string[]) =>
  execFileSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

/** Everything V1 can observe: HEAD, default index content, main + task/* refs with their commit sequences (subject + tree). */
export function v1View(root: string) {
  const gitDir = path.join(root, ".knowhow", ".git");
  const refs = gitq(gitDir, ["for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/heads/task/"]).split("\n").filter(Boolean).sort();
  const seq: Record<string, string> = {};
  for (const r of refs) seq[r] = gitq(gitDir, ["log", "--format=%s %T", r]);
  let index = "";
  try { index = gitq(gitDir, ["ls-files", "-s"]); } catch { /* unborn */ }
  return { head: fs.readFileSync(path.join(gitDir, "HEAD"), "utf8"), index, refs, seq };
}

/** path -> sha1, no mtimes (two runs in two dirs). */
export function contentManifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === ".knowhow" || r === ".git") continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out[r] = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, e.name))).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

/** Child-process V2 session (TimelineCore directly, via ts-node) running `body` JS with `c` = core. */
export function v2Child(root: string, body: string): Promise<string> {
  const core = path.resolve(__dirname, "../../../src/plugins/gitplugin/Core.ts");
  const code = `
    require(${JSON.stringify(require.resolve("ts-node"))}).register({ transpileOnly: true, skipProject: true, compilerOptions: { module: "commonjs", moduleResolution: "node", target: "es2020", esModuleInterop: true } });
    const { TimelineCore } = require(${JSON.stringify(core)});
    const fs = require("fs");
    const c = new TimelineCore({ root: process.cwd() });
    c.start();
    ${body}
  `;
  const f = path.join(os.tmpdir(), `v2child-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(f, code);
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [f], { cwd: root, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.com" } });
    let out = "", err = "";
    cp.stdout.on("data", (d: Buffer) => (out += d));
    cp.stderr.on("data", (d: Buffer) => (err += d));
    cp.on("exit", (code: number | null) => {
      fs.rmSync(f, { force: true });
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`));
    });
  });
}

export { makeProject, newPlugin, write, agentEdit };
