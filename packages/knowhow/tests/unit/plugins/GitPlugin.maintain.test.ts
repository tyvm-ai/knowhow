import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { TimelineCore } from "../../../src/plugins/gitplugin/Core";
import { diffManifest, hist, makeProject, manifest, newPlugin, agentEdit, write } from "./gitHelpers";
import { newV1 } from "./gitLegacy";

jest.setTimeout(300000);

const OLD = "2020-01-01T00:00:00Z";

/** A legacy ref (main / task/x) whose commit is `date` old, built with plumbing in the history repo. */
function legacyRef(gitDir: string, ref: string, date: string) {
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const g = (...a: string[]) => execFileSync("git", ["--git-dir", gitDir, ...a], { env, encoding: "utf8" }).trim();
  const tree = g("rev-parse", "timeline^{tree}");
  const sha = g("commit-tree", tree, "-m", "legacy");
  g("update-ref", ref, sha);
  return sha;
}

const core = (root: string, extra: Partial<ConstructorParameters<typeof TimelineCore>[0]> = {}) =>
  new TimelineCore({ root, ...extra });

const legacyRefs = (root: string) =>
  hist(root, "for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/heads/task/").split("\n").filter(Boolean);

describe("automatic maintenance (once a day, conservative)", () => {
  let p: ReturnType<typeof makeProject>;
  beforeEach(() => {
    p = makeProject("gm-");
  });
  afterEach(() => p.cleanup());

  it("runs at start, logs one line, and the stamp keeps it to once a day", () => {
    const lines: string[] = [];
    const c = core(p.root, { log: (m) => lines.push(m) });
    c.start();
    expect(fs.existsSync(path.join(p.gitDir, "knowhow-maintain.stamp"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("git maintenance:")).length).toBe(1);
    const again = c.runMaintenance();
    expect(again?.ran).toBe(false);
    expect(again?.reason).toMatch(/last day/);
    // a stamp older than a day lets it run again
    const old = new Date(Date.now() - 25 * 3600_000);
    fs.utimesSync(path.join(p.gitDir, "knowhow-maintain.stamp"), old, old);
    expect(c.runMaintenance()?.ran).toBe(true);
    c.dispose();
  });

  it("autoMaintain: false turns it off (no stamp, no gc, no reset even when over the size limit)", async () => {
    const c = core(p.root, { autoMaintain: () => false, maxRepoMb: () => 0.0001 });
    c.start();
    expect(fs.existsSync(path.join(p.gitDir, "knowhow-maintain.stamp"))).toBe(false);
    const before = hist(p.root, "rev-parse", "timeline");
    expect(c.runMaintenance(true)?.ran).toBe(false);
    expect(hist(p.root, "rev-parse", "timeline")).toBe(before);
    c.dispose();
  });

  it("under the size limit nothing is reset", () => {
    const c = core(p.root);
    c.start();
    const r = c.runMaintenance(true)!;
    expect(r.ran).toBe(true);
    expect(r.reset).toBe("none");
    c.dispose();
  });

  it("over the limit with only OLD legacy refs: timeline re-rooted AND legacy refs dropped; work tree untouched; recording continues", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.ts", "a1\n");
    await agentEdit(events, p.root, "A", "a.ts", "a2\n");
    legacyRef(p.gitDir, "refs/heads/main", OLD);
    legacyRef(p.gitDir, "refs/heads/task/old1", OLD);
    expect(legacyRefs(p.root).length).toBe(2);
    const commitsBefore = Number(hist(p.root, "rev-list", "--count", "timeline"));
    expect(commitsBefore).toBeGreaterThan(2);
    const m0 = manifest(p.root);
    const headBefore = fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8");

    const c = core(p.root, { maxRepoMb: () => 0.0001 });
    const r = c.runMaintenance(true)!;
    expect(r.reset).toBe("timeline+legacy");
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe("1");
    expect(legacyRefs(p.root)).toEqual([]);
    expect(diffManifest(m0, manifest(p.root))).toEqual([]);
    expect(fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8")).toBe(headBefore); // HEAD never moved
    expect(hist(p.root, "fsck", "--connectivity-only", "--no-dangling")).toBe("");

    // recording continues, in the same process and in a fresh one
    await agentEdit(events, p.root, "A", "a.ts", "a3\n");
    expect(plugin.core.history.log({ agent: "A", limit: 1 })[0].subject).toContain("a.ts");
    expect(hist(p.root, "show", "timeline:a.ts")).toBe("a3");
    const fresh = newPlugin();
    expect(fresh.plugin.ensureStarted()).toBe(true);
    fresh.events.emit("agent:newTask", { taskId: "B" });
    await agentEdit(fresh.events, p.root, "B", "b.ts", "b\n");
    expect(hist(p.root, "show", "timeline:b.ts")).toBe("b");
    c.dispose();
  });

  it("guard: a legacy ref changed within 24 h means NO --drop-legacy (timeline is still re-rooted)", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.ts", "a1\n");
    legacyRef(p.gitDir, "refs/heads/main", OLD);
    const freshSha = legacyRef(p.gitDir, "refs/heads/task/fresh", new Date(Date.now() - 2 * 3600_000).toISOString());
    const c = core(p.root, { maxRepoMb: () => 0.0001 });
    const r = c.runMaintenance(true)!;
    expect(r.reset).toBe("timeline");
    expect(r.reason).toBeTruthy();
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe("1");
    expect(legacyRefs(p.root).sort()).toEqual(["refs/heads/main", "refs/heads/task/fresh"]);
    expect(hist(p.root, "rev-parse", "refs/heads/task/fresh")).toBe(freshSha);
    c.dispose();
  });

  it("guard: index.lock / MERGE_HEAD (a V1 process mid-operation) means no --drop-legacy", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.ts", "a1\n");
    legacyRef(p.gitDir, "refs/heads/main", OLD);
    for (const f of ["index.lock", "MERGE_HEAD"]) {
      fs.writeFileSync(path.join(p.gitDir, f), "x\n");
      const c = core(p.root, { maxRepoMb: () => 0.0001 });
      const r = c.runMaintenance(true)!;
      expect(r.reset).toBe("timeline");
      expect(legacyRefs(p.root)).toEqual(["refs/heads/main"]);
      expect(fs.existsSync(path.join(p.gitDir, f))).toBe(true); // never removed by us
      fs.rmSync(path.join(p.gitDir, f));
      c.dispose();
    }
  });

  it("never prunes with --prune-now: a young unreferenced object survives automatic maintenance", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.ts", "a1\n");
    const blob = execFileSync("git", ["--git-dir", p.gitDir, "hash-object", "-w", "--stdin"], { input: "in-flight blob\n", encoding: "utf8" }).trim();
    const c = core(p.root, { maxRepoMb: () => 0.0001 });
    expect(c.runMaintenance(true)!.reset).not.toBe("none");
    await new Promise((r) => setTimeout(r, 1500)); // detached gc finishes
    expect(hist(p.root, "cat-file", "-t", blob)).toBe("blob");
    c.dispose();
  });

  it("a V1 fixture session can still start, edit and complete after an automatic drop-legacy; it only writes its own file", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.ts", "a1\n");
    const v = newV1();
    await v.start("old1"); // builds real V1 refs (main, task/old1) ...
    await v.edit("o.txt", "o\n", p.root);
    await v.complete("old1");
    // ... which we age past the 24 h guard
    for (const r of legacyRefs(p.root)) {
      const sha = hist(p.root, "rev-parse", r);
      const env = { ...process.env, GIT_COMMITTER_DATE: OLD, GIT_AUTHOR_DATE: OLD, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
      const g = (...a: string[]) => execFileSync("git", ["--git-dir", p.gitDir, ...a], { env, encoding: "utf8" }).trim();
      const old = g("commit-tree", `${sha}^{tree}`, "-m", "aged");
      g("update-ref", r, old);
    }
    const c = core(p.root, { maxRepoMb: () => 0.0001 });
    expect(c.runMaintenance(true)!.reset).toBe("timeline+legacy");
    c.dispose();

    const before = manifest(p.root);
    const v1 = newV1(); // a fresh old-CLI process
    await v1.start("after1");
    await v1.edit("src/after.ts", "x\n", p.root);
    await v1.complete("after1");
    expect(diffManifest(before, manifest(p.root))).toEqual(["src/after.ts"]);
    expect(hist(p.root, "rev-parse", "--verify", "timeline").length).toBe(40);
    expect(hist(p.root, "show", "main:src/after.ts")).toBe("x");
  });
});

describe("pruneTaskRefs keeps only the newest N task marker pairs", () => {
  it("keeps the newest N (ported from the old 'newest N task branches' test)", async () => {
    const p = makeProject("gm-prune-");
    try {
      const { plugin, events } = newPlugin();
      for (let i = 1; i <= 4; i++) {
        events.emit("agent:newTask", { taskId: `t${i}` });
        await agentEdit(events, p.root, `t${i}`, `f${i}.txt`, `${i}\n`);
        events.emit("agent:taskComplete", { taskId: `t${i}` });
        await new Promise((r) => setTimeout(r, 1100)); // committer dates have 1 s resolution
      }
      const ids = () =>
        new Set(
          hist(p.root, "for-each-ref", "--format=%(refname)", "refs/knowhow/tasks/")
            .split("\n").filter(Boolean).map((r) => r.split("/")[3])
        );
      expect(ids().size).toBe(4);
      const removed = plugin.core.pruneTaskRefs(2);
      expect(removed).toBe(2);
      expect([...ids()].sort()).toEqual(["t3", "t4"]);
      expect(plugin.core.pruneTaskRefs(2)).toBe(0);
      // the timeline itself keeps every commit
      expect(plugin.core.history.log({ agent: "t1" }).length).toBe(1);
      void write;
    } finally {
      p.cleanup();
    }
  });
});
