import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { agentEdit, hist, makeProject, newPlugin, sh, write } from "./gitHelpers";
import { GitPlugin } from "../../../src/plugins/GitPlugin";

describe("GitPlugin phase 1+2: attribution, CAS, timeline", () => {
  let p: ReturnType<typeof makeProject>;
  beforeEach(() => {
    p = makeProject();
  });
  afterEach(() => p.cleanup());

  it("interleaved agents: B's commit contains only B's path, even with A's dirty file on disk", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    events.emit("agent:newTask", { taskId: "B" });
    write(p.root, "a.ts", "A edit 1\n"); // A wrote, event not yet seen
    await agentEdit(events, p.root, "B", "b.ts", "B edit\n");
    const files = hist(p.root, "show", "--name-only", "--format=", "timeline").split("\n").filter(Boolean);
    expect(files).toEqual(["b.ts"]);
    expect(hist(p.root, "log", "-1", "--format=%B", "timeline")).toContain("Agent: B");
    await agentEdit(events, p.root, "A", "a.ts", "A edit 2\n");
    const aFiles = hist(p.root, "show", "--name-only", "--format=", "timeline").split("\n").filter(Boolean);
    expect(aFiles).toEqual(["a.ts"]);
    expect(plugin.core.history.filesFor("A")).toEqual(["a.ts"]);
    expect(plugin.core.history.filesFor("B")).toEqual(["b.ts"]);
  });

  it("20 parallel recordChange calls + 4 child processes: no lost commit, linear history", async () => {
    const { plugin } = newPlugin();
    plugin.ensureStarted();
    const n0 = Number(hist(p.root, "rev-list", "--count", "timeline"));
    for (let i = 0; i < 20; i++) write(p.root, `par/p${i}.txt`, `v${i}\n`);
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) =>
        plugin.core.recorder.recordChange({ agent: `P${i}`, kind: "edit", summary: `p${i}`, paths: [`par/p${i}.txt`] })
      )
    );
    // child processes
    const script = path.join(p.root, "child.cjs");
    const children: Promise<void>[] = [];
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 5; i++) write(p.root, `kid/c${c}_${i}.txt`, `c${c}${i}\n`);
    }
    const code = `
      require(${JSON.stringify(require.resolve("ts-node"))}).register({ transpileOnly: true, skipProject: true, compilerOptions: { module: "commonjs", moduleResolution: "node", target: "es2020", esModuleInterop: true } });
      const { TimelineCore } = require(${JSON.stringify(path.resolve(__dirname, "../../../src/plugins/gitplugin/Core.ts"))});
      const c = new TimelineCore({ root: process.cwd() });
      const k = process.argv[2];
      for (let i = 0; i < 5; i++) c.recorder.recordChange({ agent: "K" + k, kind: "edit", summary: "k", paths: ["kid/c" + k + "_" + i + ".txt"] });
    `;
    fs.writeFileSync(script, code);
    for (let c = 0; c < 4; c++) {
      children.push(
        new Promise<void>((resolve, reject) => {
          const cp = require("child_process").spawn(process.execPath, [script, String(c)], {
            cwd: p.root,
            stdio: "pipe",
          });
          let err = "";
          cp.stderr.on("data", (d: Buffer) => (err += d));
          cp.on("exit", (code: number) => (code === 0 ? resolve() : reject(new Error(err))));
        })
      );
    }
    await Promise.all(children);
    const n1 = Number(hist(p.root, "rev-list", "--count", "timeline"));
    expect(n1 - n0).toBe(40);
    expect(hist(p.root, "rev-list", "--merges", "--count", "timeline")).toBe("0");
    const tree = hist(p.root, "ls-tree", "-r", "--name-only", "timeline").split("\n");
    expect(tree.filter((f) => f.startsWith("par/")).length).toBe(20);
    expect(tree.filter((f) => f.startsWith("kid/")).length).toBe(20);
  }, 120000);

  it("secrets and oversize files are never recorded", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", ".env", "TOKEN=1\n");
    await agentEdit(events, p.root, "A", "deep/cert.pem", "x\n");
    await agentEdit(events, p.root, "A", "node_modules/x/i.js", "1\n");
    const big = path.join(p.root, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
    await events.emitBlocking("file:post-edit", { filePath: big, taskId: "A", operation: "write" });
    await agentEdit(events, p.root, "A", "ok.txt", "ok\n");
    const files = hist(p.root, "ls-tree", "-r", "--name-only", "timeline").split("\n");
    expect(files).toContain("ok.txt");
    for (const f of [".env", "deep/cert.pem", "node_modules/x/i.js", "big.bin"]) expect(files).not.toContain(f);
    expect(plugin.core.history.log({ agent: "A" }).length).toBe(1);
  });

  it("an edit that changes nothing creates no commit", async () => {
    const { events, plugin } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "x.txt", "1\n");
    const n = hist(p.root, "rev-list", "--count", "timeline");
    await agentEdit(events, p.root, "A", "x.txt", "1\n");
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe(n);
    expect(plugin.core.history.log({ agent: "A" }).length).toBe(1);
  });

  it("A starts, B starts, A completes while B writes: HEAD never moves, no task/* branches, B's commits stay", async () => {
    const { events, plugin } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    const headBefore = fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8");
    await agentEdit(events, p.root, "A", "a.ts", "a1\n");
    events.emit("agent:newTask", { taskId: "B" });
    await agentEdit(events, p.root, "B", "b.ts", "b1\n");
    events.emit("agent:taskComplete", { taskId: "A" });
    await agentEdit(events, p.root, "B", "b.ts", "b2\n");
    await agentEdit(events, p.root, "B", "b2.ts", "b2\n");
    events.emit("agent:taskComplete", { taskId: "B" });
    expect(fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8")).toBe(headBefore);
    expect(hist(p.root, "for-each-ref", "refs/heads/task/")).toBe("");
    expect(plugin.core.history.log({ agent: "B" }).length).toBe(3);
    expect(plugin.core.history.log({ agent: "A" }).length).toBe(1);
    const refs = hist(p.root, "for-each-ref", "--format=%(refname)", "refs/knowhow/tasks/").split("\n");
    expect(refs).toEqual(expect.arrayContaining(["refs/knowhow/tasks/A/start", "refs/knowhow/tasks/A/end", "refs/knowhow/tasks/B/end"]));
    // end ref of A is before B's later edits
    const aEnd = hist(p.root, "rev-parse", "refs/knowhow/tasks/A/end");
    const tip = hist(p.root, "rev-parse", "timeline");
    expect(aEnd).not.toBe(tip);
    expect(hist(p.root, "merge-base", "--is-ancestor", aEnd, tip) === "" ).toBe(true);
    expect(fs.readFileSync(path.join(p.root, "b.ts"), "utf8")).toBe("b2\n");
  });

  it("call() lists last timeline commits, not a current branch", async () => {
    const { events, plugin } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.ts", "a\n");
    const text = await plugin.call("");
    expect(text).toContain("timeline");
    expect(text).toContain("[A] edit: write a.ts");
    expect(text).not.toContain("Current branch");
  });

  it("kill switches: KNOWHOW_DISABLE_GIT_PLUGIN=1 and plugins.disabled [git] record nothing; an old `timeline: true` config is harmless", async () => {
    const { plugin, events } = newPlugin();
    process.env.KNOWHOW_DISABLE_GIT_PLUGIN = "1";
    try {
      expect(plugin.isEnabled()).toBe(false);
      events.emit("agent:newTask", { taskId: "K" });
      await agentEdit(events, p.root, "K", "k.ts", "k\n");
      expect(fs.existsSync(p.gitDir)).toBe(false); // nothing created, nothing recorded
    } finally {
      delete process.env.KNOWHOW_DISABLE_GIT_PLUGIN;
    }
    // plugins.disabled: ["git"] goes through PluginService.refreshConfiguredState -> plugin.disable()
    plugin.disable();
    expect(plugin.isEnabled()).toBe(false);
    await agentEdit(events, p.root, "K", "k2.ts", "k2\n");
    expect(fs.existsSync(p.gitDir)).toBe(false);
    plugin.enable();
    // a project config that still says timeline: true (and the env of the opt-in era) is ignored, not an error
    write(p.root, ".knowhow/knowhow.json", JSON.stringify({ gitPlugin: { timeline: true, maxFileMb: 5 } }));
    process.env.KNOWHOW_GIT_PLUGIN_V2 = "1";
    try {
      const fresh = newPlugin();
      expect(fresh.plugin.ensureStarted()).toBe(true);
      fresh.events.emit("agent:newTask", { taskId: "K2" });
      await agentEdit(fresh.events, p.root, "K2", "k3.ts", "k3\n");
      expect(fresh.plugin.core.history.log({ agent: "K2" }).length).toBe(1);
    } finally {
      delete process.env.KNOWHOW_GIT_PLUGIN_V2;
    }
  });

  it("the default plugin set contains this plugin under the key git", () => {
    const { CliPluginService } = require("../../../src/plugins/plugins");
    const svc = new CliPluginService({ Events: newPlugin().events } as any);
    expect(svc.getPlugin("git")).toBeInstanceOf(GitPlugin);
  });
});

// keep imports used
void sh;
void execFileSync;
void GitPlugin;
