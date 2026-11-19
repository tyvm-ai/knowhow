import * as fs from "fs";
import * as path from "path";
import { agentEdit, diffManifest, hist, makeProject, manifest, newPlugin, sh, write } from "./gitHelpers";
import { LegacyV1GitPlugin } from "./legacyV1GitPlugin.fixture";
import { EventService } from "../../../src/services/EventService";
import { GitRunner, GitSafetyError, assertAllowed } from "../../../src/plugins/gitplugin/GitRunner";

const ls = (root: string) => hist(root, "ls-tree", "-r", "--name-only", "timeline").split("\n").filter(Boolean);
const kinds = (root: string, kind: string) =>
  hist(root, "log", "--format=%H", "-E", `--grep=^Kind: ${kind}$`, "timeline").split("\n").filter(Boolean);

async function sequence(events: EventService, root: string) {
  events.emit("agent:newTask", { taskId: "B" });
  await agentEdit(events, root, "B", "src/b.ts", "b\n");
  events.emit("agent:taskComplete", { taskId: "B" });
  events.emit("agent:newTask", { taskId: "C" });
}

describe("GitPlugin incident regression (design 12.4)", () => {
  let p: ReturnType<typeof makeProject>;
  beforeEach(() => {
    p = makeProject("gv2i-");
  });
  afterEach(() => p.cleanup());

  it("1. ignore after track: file stays byte+mtime identical, tip has no data/gen, one untrack commit", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "data/gen/a.json", '{"x":1}\n');
    expect(ls(p.root)).toContain("data/gen/a.json");
    const st0 = fs.statSync(path.join(p.root, "data/gen/a.json"));
    write(p.root, ".gitignore", "node_modules\n.knowhow\ndata/gen/\n");
    await sequence(events, p.root);
    plugin.core.sweeper.sweep();
    const st1 = fs.statSync(path.join(p.root, "data/gen/a.json"));
    expect(fs.readFileSync(path.join(p.root, "data/gen/a.json"), "utf8")).toBe('{"x":1}\n');
    expect(st1.mtimeMs).toBe(st0.mtimeMs);
    expect(ls(p.root).some((f) => f.startsWith("data/gen/"))).toBe(false);
    expect(kinds(p.root, "untrack").length).toBe(1);
    // test 4: stale snapshot protection - revert is a stretch item (not implemented); here we check
    // the file is also not reintroduced by a later sweep after it changes on disk
    write(p.root, "data/gen/a.json", '{"x":2}\n');
    plugin.core.sweeper.sweep();
    expect(ls(p.root).some((f) => f.startsWith("data/gen/"))).toBe(false);
    expect(fs.readFileSync(path.join(p.root, "data/gen/a.json"), "utf8")).toBe('{"x":2}\n');
  });

  it("2. oversize after track: same guarantees", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "data/big.json", "small\n");
    expect(ls(p.root)).toContain("data/big.json");
    const big = Buffer.alloc(26 * 1024 * 1024, 97);
    write(p.root, "data/big.json", big);
    const st0 = fs.statSync(path.join(p.root, "data/big.json"));
    await sequence(events, p.root);
    plugin.core.sweeper.sweep();
    const st1 = fs.statSync(path.join(p.root, "data/big.json"));
    expect(st1.size).toBe(big.length);
    expect(st1.mtimeMs).toBe(st0.mtimeMs);
    expect(fs.readFileSync(path.join(p.root, "data/big.json")).equals(big)).toBe(true);
    expect(ls(p.root)).not.toContain("data/big.json");
    expect(kinds(p.root, "untrack").length).toBe(1);
  });

  it("3. migration from a legacy V1 repo: work tree, HEAD, default index and task/* untouched; timeline seeded at old HEAD", async () => {
    // build the fixture with the frozen old V1 plugin
    (LegacyV1GitPlugin as any).isListening = false;
    (LegacyV1GitPlugin as any).excludesReady.clear();
    const v1events = new EventService();
    const v1 = new LegacyV1GitPlugin({ Events: v1events } as any);
    v1.enable();
    write(p.root, "src/keep.ts", "k\n");
    for (const id of ["old1", "old2"]) {
      v1events.emit("agent:newTask", { taskId: id });
      await new Promise((r) => setTimeout(r, 400));
      write(p.root, `data/old/${id}.json`, `{"${id}":1}\n`);
      write(p.root, `scripts/tmp/${id}.ts`, `// ${id}\n`);
      await v1events.emitBlocking("file:post-edit", { filePath: path.join(p.root, `data/old/${id}.json`), operation: "write" });
      await new Promise((r) => setTimeout(r, 1200));
      await v1events.emitBlocking("agent:taskComplete", { taskId: id, answer: "done" });
      await new Promise((r) => setTimeout(r, 1200));
    }
    v1events.emit("agent:newTask", { taskId: "x" });
    await new Promise((r) => setTimeout(r, 400));
    write(p.root, "src/ahead.ts", "ahead\n");
    await v1events.emitBlocking("file:post-edit", { filePath: path.join(p.root, "src/ahead.ts"), operation: "write" });
    await new Promise((r) => setTimeout(r, 1500)); // V1 commits asynchronously
    const g = (...a: string[]) => hist(p.root, ...a);
    const head = fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8");
    expect(head).toContain("refs/heads/task/x");
    const mainSha = g("rev-parse", "main");
    const headSha = g("rev-parse", "HEAD");
    expect(headSha).not.toBe(mainSha); // HEAD ahead of main
    // paths that are now ignored but tracked in old branches
    write(p.root, ".gitignore", "node_modules\n.knowhow\ndata/old/\nscripts/tmp/*\n");
    const taskRefs = () =>
      g("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/main", "refs/heads/task/");
    const refsBefore = taskRefs();
    const indexBefore = fs.readFileSync(path.join(p.gitDir, "index"));
    const mBefore = manifest(p.root);

    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "V2A" });
    plugin.core.sweeper.sweep();
    events.emit("agent:taskComplete", { taskId: "V2A" });

    expect(diffManifest(mBefore, manifest(p.root))).toEqual([]);
    expect(fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8")).toBe(head);
    expect(fs.readFileSync(path.join(p.gitDir, "index")).equals(indexBefore)).toBe(true);
    expect(taskRefs()).toBe(refsBefore);
    // timeline descends from the old HEAD commit
    expect(g("merge-base", "--is-ancestor", headSha, "timeline") === "").toBe(true);
    expect(g("rev-parse", "timeline~0").length).toBeGreaterThan(0);
    // the now-ignored paths are not in the timeline tip
    expect(ls(p.root).some((f) => f.startsWith("data/old/") || f.startsWith("scripts/tmp/"))).toBe(false);
    expect(sh(p.root, "status", "--porcelain")).toContain(".gitignore");
  }, 120000);

  it("5. work tree immutability property: random events from three agents never touch files the test did not write", async () => {
    const { plugin, events } = newPlugin();
    // pre-existing files: tracked, ignored, secret, oversize-later
    write(p.root, "src/pre1.ts", "1\n");
    write(p.root, "data/live/unique-table.json", "{}\n");
    write(p.root, ".gitignore", "node_modules\n.knowhow\ndata/live/\n");
    write(p.root, ".env", "T=1\n");
    write(p.root, "grow.json", "x\n");
    plugin.core.sweeper.sweep();
    const untouched = ["src/pre1.ts", "data/live/unique-table.json", ".env", "README.md"];
    const m0 = manifest(p.root);
    const written = new Set<string>();
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const agents = ["A1", "A2", "A3"];
    const started = new Set<string>();
    const execCounter = { n: 0 };
    for (let i = 0; i < 60; i++) {
      const a = agents[rnd(3)];
      switch (rnd(7)) {
        case 0:
          events.emit("agent:newTask", { taskId: a });
          started.add(a);
          break;
        case 1:
        case 2: {
          const f = `src/${a}/f${rnd(4)}.ts`;
          written.add(f);
          await agentEdit(events, p.root, a, f, `v${i}\n`);
          break;
        }
        case 3: {
          const id = `e${execCounter.n++}`;
          await events.emitBlocking("exec:pre-run", { command: "gen", taskId: a, execId: id });
          const f = `gen/${a}-${rnd(3)}.txt`;
          written.add(f);
          write(p.root, f, `g${i}\n`);
          await events.emitNonBlocking("tool:execCommand:done", { command: "gen", taskId: a, execId: id, exitCode: 0 });
          break;
        }
        case 4:
          events.emit("agent:taskComplete", { taskId: a });
          break;
        case 5:
          plugin.core.sweeper.sweep();
          break;
        case 6:
          plugin.core.doctor.check({ full: rnd(5) === 0 });
          break;
      }
      if (i === 30) {
        write(p.root, "grow.json", Buffer.alloc(26 * 1024 * 1024, 1)); // oversize after track
        written.add("grow.json");
      }
    }
    const m1 = manifest(p.root);
    const changed = diffManifest(m0, m1).filter((f) => !written.has(f));
    expect(changed).toEqual([]);
    for (const f of untouched) expect(m1[f]).toEqual(m0[f]);
    expect(hist(p.root, "for-each-ref", "refs/heads/task/")).toBe("");
    expect(hist(p.root, "fsck", "--connectivity-only", "--no-dangling")).toBe("");
  }, 300000);

  it("6. wrapper allow-list: forbidden commands throw before git is spawned", () => {
    const runner = new GitRunner(p.gitDir, p.root);
    const bad: string[][] = [
      ["checkout", "main"],
      ["merge", "--squash", "x"],
      ["reset", "--hard"],
      ["stash"],
      ["clean", "-fd"],
      ["rm", "a.txt"],
      ["rm", "--cached", "a.txt"],
      ["read-tree", "-u", "HEAD"],
      ["read-tree", "-m", "HEAD"],
      ["read-tree", "--reset", "HEAD"],
      ["restore", "a.txt"],
      ["switch", "x"],
      ["--work-tree", "/tmp", "status"],
      ["merge-file", "a", "b", "c"],
      ["add", "-A"],
      ["commit", "-m", "x"],
      ["branch", "-D", "x"],
    ];
    for (const args of bad) {
      expect(() => assertAllowed(args)).toThrow(GitSafetyError);
      expect(() => runner.run(args)).toThrow(GitSafetyError);
    }
    expect(runner.spawnCount).toBe(0);
    // allowed ones pass the gate
    for (const args of [["rev-parse", "HEAD"], ["read-tree", "--empty"], ["update-index", "--add", "a"], ["merge-file", "-p", "a", "b", "c"]]) {
      expect(() => assertAllowed(args)).not.toThrow();
    }
  });
});
