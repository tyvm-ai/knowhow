import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { EventService } from "../../../src/services/EventService";
import { contentManifest, newV1, v1View, v2Child } from "./gitLegacy";
import { agentEdit, hist, makeProject, newPlugin, write } from "./gitHelpers";

const norm = (v: ReturnType<typeof v1View>, root: string) => {
  const n = (s: string) => s.split(root).join("ROOT").replace(/sync [0-9a-f]{7,}/g, "sync X").replace(/sync \d{4}-[\d\-T:.Z]+/g, "sync X");
  return { head: v.head, index: v.index, refs: v.refs, seq: Object.fromEntries(Object.entries(v.seq).map(([k, s]) => [k, n(s)])) };
};
const seedV1 = async (root: string) => {
  const v = newV1();
  await v.start("S0");
  await v.edit("seed.txt", "s\n", root);
  await v.complete("S0");
};
const tick = (ms = 1100) => new Promise((r) => setTimeout(r, ms));

/**
 * One scripted V1 life: parent P starts and edits, a child C starts/edits/runs a shell edit/completes
 * (V2 only when `withV2`), P keeps editing, then V1 task Q starts (ensureCleanState: checkout main + squash)
 * and resumes P's branch (setBranch). The files V2 children write exist in both runs.
 */
async function script(root: string, withV2: boolean) {
  const v1 = newV1();
  const v2 = withV2 ? newPlugin(new EventService()) : null;
  const childEdit = async (id: string, rel: string, c: string) => {
    if (v2) await agentEdit(v2.events, root, id, rel, c);
    else write(root, rel, c);
  };
  await v1.start("P");
  await v1.edit("p1.txt", "p1\n", root);
  if (v2) {
    v2.events.emit("agent:newTask", { taskId: "C1" });
    await v2.events.emitBlocking("exec:pre-run", { command: "sed", taskId: "C1", execId: "x1" });
  }
  await childEdit("C1", "c1.txt", "c1\n");
  write(root, "shell.txt", "shell\n");
  if (v2) await v2.events.emitNonBlocking("tool:execCommand:done", { command: "sed", taskId: "C1", execId: "x1", exitCode: 0, background: false });
  await v1.edit("p2.txt", "p2\n", root);
  if (v2) v2.events.emit("agent:taskComplete", { taskId: "C1" });
  await childEdit("C2", "c2.txt", "c2\n");
  await v1.edit("p3.txt", "p3\n", root);
  await v1.complete("P");
  await v1.start("Q");
  await v1.edit("q1.txt", "q1\n", root);
  await v1.resume("task/P");
  await v1.edit("p4.txt", "p4\n", root);
  await v1.complete("P");
  return { v2 };
}

describe("GitPlugin next to a running V1 (A1)", () => {
  jest.setTimeout(300000);
  const made: ReturnType<typeof makeProject>[] = [];
  afterEach(() => { while (made.length) made.pop()!.cleanup(); });
  const proj = (n: string) => { const p = makeProject(n); made.push(p); return p; };

  it("in one process: V1's HEAD, index, main, task/* refs and commit sequence equal the V2-off run", async () => {
    const off = proj("gv2m-off-");
    await script(off.root, false);
    const viewOff = norm(v1View(off.root), off.root);
    const manOff = contentManifest(off.root);
    process.chdir(off.root);
    const on = proj("gv2m-on-");
    const { v2 } = await script(on.root, true);
    expect(v2!.plugin.core.history.log({ agent: "C1" }).length).toBeGreaterThan(1);
    const viewOn = norm(v1View(on.root), on.root);
    expect(viewOn).toEqual(viewOff);
    expect(contentManifest(on.root)).toEqual(manOff);
    expect(hist(on.root, "rev-parse", "--verify", "refs/heads/timeline").length).toBe(40);
    // V1 never saw V2's refs or private files in its tree
    expect(viewOn.refs.some((r) => r.includes("timeline") || r.includes("knowhow"))).toBe(false);
  });

  const seed = async (root: string) => {
    const v = newV1();
    await v.start("S0");
    await v.edit("seed.txt", "s\n", root);
    await v.complete("S0");
  };

  it("separate processes: V2 child processes record and sweep while V1 runs its whole life", async () => {
    const off = proj("gv2m-poff-");
    await seed(off.root);
    for (let i = 0; i < 6; i++) write(off.root, `pre/f${i}.txt`, `${i}\n`);
    for (let i = 0; i < 25; i++) write(off.root, `kid/k${i}.txt`, `${i}\n`);
    await script(off.root, false);
    const viewOff = norm(v1View(off.root), off.root);
    process.chdir(off.root);
    const on = proj("gv2m-pon-");
    await seed(on.root);
    for (let i = 0; i < 6; i++) write(on.root, `pre/f${i}.txt`, `${i}\n`);
    // The work tree is shared, so anything a V2 child writes would also reach V1's `add -A`.
    // The files therefore exist before both runs; the child only records them (no work tree writes).
    const ready = path.join(on.root, "..", `v2ready-${path.basename(on.root)}`);
    const body = `
      fs.writeFileSync(${JSON.stringify(ready)}, "1");
      while (!fs.existsSync("kid/k24.txt")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      for (let i = 0; i < 25; i++) {
        c.recorder.recordChange({ agent: "K1", kind: "edit", summary: "k" + i, paths: ["pre/f" + (i % 6) + ".txt", "kid/k" + i + ".txt"] });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      }
      c.sweeper.sweep();`;
    const child = v2Child(on.root, body);
    // wait until the child finished its start (baseline sweep), then drop the files it will record
    for (let i = 0; i < 300 && !fs.existsSync(ready); i++) await tick(100);
    for (let i = 0; i < 25; i++) write(on.root, `kid/k${i}.txt`, `${i}\n`);
    await script(on.root, false);
    await child;
    fs.rmSync(ready, { force: true });
    const viewOn = norm(v1View(on.root), on.root);
    expect(viewOn.head).toBe(viewOff.head);
    expect(viewOn.refs).toEqual(viewOff.refs);
    expect(viewOn.seq).toEqual(viewOff.seq);
    expect(viewOn.index).toBe(viewOff.index);
    expect(hist(on.root, "log", "--format=%H", "-E", "--grep=^Agent: K1$", "timeline").split("\n").filter(Boolean).length).toBeGreaterThan(10);
    expect(hist(on.root, "fsck", "--connectivity-only", "--no-dangling").replace(/^notice:.*$/gm, "")).toBe("");
  });

  it("V2 creating the history repo before V1 ever ran: V1 still ends with the same trees and refs (only commit subjects differ)", async () => {
    const off = proj("gv2m-foff-");
    await script(off.root, false);
    const trees = (v: ReturnType<typeof v1View>) =>
      Object.fromEntries(Object.entries(v.seq).map(([k, s]) => [k, s.split("\n").map((l) => l.split(" ").pop())]));
    const vOff = v1View(off.root);
    process.chdir(off.root);
    const on = proj("gv2m-fon-");
    newPlugin(new EventService()).plugin.ensureStarted(); // V2 creates .knowhow/.git first
    await script(on.root, false);
    const vOn = v1View(on.root);
    expect(vOn.refs).toEqual(vOff.refs);
    expect(vOn.head).toBe(vOff.head);
    // the newest tree of every ref is identical
    for (const k of vOff.refs) expect(trees(vOn)[k][0]).toBe(trees(vOff)[k][0]);
  });

  it("V1 never moves, deletes or rewrites refs/heads/timeline; V1 prune + gc keep V2's objects", async () => {
    const p = proj("gv2m-gc-");
    const { plugin, events } = newPlugin(new EventService());
    plugin.ensureStarted();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.txt", "a\n");
    const tip = hist(p.root, "rev-parse", "timeline");
    const blob = execFileSync("git", ["--git-dir", p.gitDir, "hash-object", "-w", "--stdin"], { input: "pending-v2-object\n", encoding: "utf8" }).trim();
    for (const k of ["gc.auto=1", "gc.autoPackLimit=1", "gc.autoDetach=false"]) {
      const [a, b] = k.split("=");
      hist(p.root, "config", a, b);
    }
    const v1 = newV1();
    for (let i = 0; i < 24; i++) await v1.start(`T${i}`), await v1.edit(`t${i}.txt`, `${i}\n`, p.root), await v1.complete(`T${i}`);
    (v1.v1 as any).pruneTaskBranches();
    expect(hist(p.root, "for-each-ref", "refs/heads/task/").split("\n").length).toBeLessThanOrEqual(20);
    expect(hist(p.root, "rev-parse", "--verify", "refs/heads/timeline")).toBe(tip);
    // `gc --auto` rarely fires in a tiny repo, so run the very command V1 uses without --auto (default prune: 2 weeks)
    hist(p.root, "gc", "--quiet");
    expect(fs.readdirSync(path.join(p.gitDir, "objects", "pack")).some((f) => f.endsWith(".pack"))).toBe(true);
    expect(hist(p.root, "cat-file", "-t", blob)).toBe("blob"); // young unreferenced object survives V1's gc
    expect(hist(p.root, "fsck", "--connectivity-only", "--no-dangling")).toBe("");
    expect(plugin.core.history.log({ agent: "A" }).length).toBe(1);
  });

  it("V2's persistent files never reach V1's add -A", async () => {
    const p = proj("gv2m-add-");
    const { plugin, events } = newPlugin(new EventService());
    plugin.ensureStarted();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "a.txt", "a\n");
    const v1 = newV1();
    await v1.start("P");
    await v1.edit("p.txt", "p\n", p.root);
    const files = hist(p.root, "ls-tree", "-r", "--name-only", "task/P").split("\n");
    expect(files.filter((f) => f.startsWith(".knowhow") || f.includes("idx.") || f.includes("sweep"))).toEqual([]);
    expect(fs.existsSync(path.join(p.root, ".knowhow", ".git", "sweep.index"))).toBe(true);
  });

  it("V1 left-over states never make the doctor move the repo aside", async () => {
    const states: Record<string, (gd: string) => void> = {
      "index.lock": (gd) => fs.writeFileSync(path.join(gd, "index.lock"), ""),
      "merge in progress": (gd) => fs.writeFileSync(path.join(gd, "MERGE_HEAD"), "0".repeat(40) + "\n"),
      "detached HEAD": (gd) => fs.writeFileSync(path.join(gd, "HEAD"), fs.readFileSync(path.join(gd, "refs/heads/timeline"), "utf8").trim() + "\n"),
      "gc.log": (gd) => fs.writeFileSync(path.join(gd, "gc.log"), "fatal: Failed to traverse parents of commit 70c3127\n"),
      "broken legacy ref": (gd) => {
        const bad = execFileSync("git", ["--git-dir", gd, "hash-object", "-t", "commit", "-w", "--stdin"], {
          input: `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${"1".repeat(40)}\nauthor a <a@a> 1 +0000\ncommitter a <a@a> 1 +0000\n\nx\n`, encoding: "utf8",
        }).trim();
        fs.mkdirSync(path.join(gd, "refs/transport"), { recursive: true });
        fs.writeFileSync(path.join(gd, "refs/transport/t1"), bad + "\n");
      },
    };
    for (const [name, apply] of Object.entries(states)) {
      const p = proj("gv2m-doc-");
      const first = newPlugin(new EventService());
      await seedV1(p.root);
      first.plugin.ensureStarted();
      apply(p.gitDir);
      const stamp = path.join(p.gitDir, "knowhow-fsck.stamp");
      fs.rmSync(stamp, { force: true }); // force the full probe
      const second = newPlugin(new EventService());
      second.plugin.ensureStarted();
      expect([name, second.plugin.core.repaired]).toEqual([name, undefined]);
      expect(fs.readdirSync(path.join(p.root, ".knowhow")).filter((n) => n.includes("broken"))).toEqual([]);
      if (name === "index.lock") expect(fs.existsSync(path.join(p.gitDir, "index.lock"))).toBe(true);
    }
  });

  it("a timeline that really is broken is still repaired when no V1 state is present, and refused when index.lock exists", async () => {
    const breakTip = (gd: string, root: string) => {
      const tree = hist(root, "rev-parse", "timeline^{tree}");
      const loose = path.join(gd, "objects", tree.slice(0, 2), tree.slice(2));
      fs.chmodSync(loose, 0o644);
      fs.rmSync(loose);
    };
    const a = proj("gv2m-rep-");
    write(a.root, "unique-a.txt", "only in the history repo\n"); // a tree the real repo does not have
    newPlugin(new EventService()).plugin.ensureStarted();
    breakTip(a.gitDir, a.root);
    const p2 = newPlugin(new EventService()).plugin;
    p2.ensureStarted();
    expect(p2.core.repaired).toBeTruthy();
    // with an index.lock V1 may be mid-commit: refuse (start fails, nothing is moved)
    const b = proj("gv2m-rep2-");
    write(b.root, "unique-b.txt", "only in the history repo\n");
    newPlugin(new EventService()).plugin.ensureStarted();
    breakTip(b.gitDir, b.root);
    fs.writeFileSync(path.join(b.gitDir, "index.lock"), "");
    const p3 = newPlugin(new EventService()).plugin;
    expect(p3.ensureStarted()).toBe(false);
    expect(fs.existsSync(b.gitDir)).toBe(true);
    expect(fs.readdirSync(path.join(b.root, ".knowhow")).filter((n) => n.includes("broken"))).toEqual([]);
  });

  it("V1's own delete bug (design 12.2) is neither made more likely nor fixed by V2; V2 writes only the same exclude lines V1 writes", async () => {
    // Same script with and without V2: track data/gen with V1, ignore it, V1 starts a new task (checkout main + squash merge).
    const outcome = async (withV2: boolean) => {
      const p = proj(withV2 ? "gv2m-bug-on-" : "gv2m-bug-off-");
      const v1 = newV1();
      await v1.start("P");
      await v1.edit("data/gen/a.json", "{}\n", p.root);
      await v1.complete("P");
      await v1.start("P2");
      await v1.edit("keep.txt", "k\n", p.root);
      let v2: ReturnType<typeof newPlugin> | null = null;
      if (withV2) {
        v2 = newPlugin(new EventService());
        v2.plugin.ensureStarted();
        v2.events.emit("agent:newTask", { taskId: "C" });
        v2.plugin.core.sweeper.sweep();
      }
      write(p.root, ".gitignore", "node_modules\n.knowhow\ndata/gen/\n");
      const excludeBefore = fs.readFileSync(path.join(p.gitDir, "info", "exclude"), "utf8");
      const configBefore = fs.readFileSync(path.join(p.gitDir, "config"), "utf8");
      const v1b = newV1(); // a fresh V1 process: excludesReady is empty so ensureInternalExcludes + untrackIgnoredFiles run
      await v1b.start("P3");
      const exists = fs.existsSync(path.join(p.root, "data/gen/a.json"));
      const exclude = fs.readFileSync(path.join(p.gitDir, "info", "exclude"), "utf8");
      return { exists, exclude, excludeBefore, config: fs.readFileSync(path.join(p.gitDir, "config"), "utf8"), configBefore, v2 };
    };
    const off = await outcome(false);
    const on = await outcome(true);
    expect(on.exists).toBe(off.exists); // whatever V1 does to the file, V2's presence does not change it
    expect(on.exclude.split("\n").filter(Boolean).sort()).toEqual(off.exclude.split("\n").filter(Boolean).sort());
    expect(on.configBefore).toBe(on.config); // V2 never writes `config`
    // alternates is written by V2 (permanent link to the real repo) and is a valid, existing path
    const proj2 = made[made.length - 1];
    const alt = fs.readFileSync(path.join(proj2.gitDir, "objects", "info", "alternates"), "utf8").trim().split("\n");
    expect(alt.every((l) => fs.existsSync(l))).toBe(true);
    // record (not assert) the V1 outcome in the test output for the certification report
    console.log(`V1 delete bug reproduced with V1 only: ${off.exists ? "NO (file kept)" : "YES (file deleted)"}; with V2 present: ${on.exists ? "NO (file kept)" : "YES (file deleted)"}`);
  });
});
