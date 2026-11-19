import * as fs from "fs";
import * as path from "path";
import { agentEdit, diffManifest, hist, makeProject, manifest, newPlugin, write } from "./gitHelpers";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("GitPlugin restore / revert / reset (A4, A5)", () => {
  jest.setTimeout(300000);
  let p: ReturnType<typeof makeProject>;
  beforeEach(() => { p = makeProject("gv2r-"); });
  afterEach(() => p.cleanup());

  it("revert --agent: disjoint hunks of one file: A's hunk goes, B's stays; B-only file untouched", async () => {
    const { plugin, events } = newPlugin();
    write(p.root, "f.txt", lines(30));
    events.emit("agent:newTask", { taskId: "A" });
    plugin.core.sweeper.sweep();
    await agentEdit(events, p.root, "A", "f.txt", read(p.root, "f.txt").replace("line 3\n", "A3\n"));
    events.emit("agent:newTask", { taskId: "B" });
    await agentEdit(events, p.root, "B", "f.txt", read(p.root, "f.txt").replace("line 27\n", "B27\n"));
    await agentEdit(events, p.root, "B", "b.txt", "b\n");
    const dry = plugin.core.revert({ agent: "A" });
    expect(dry.applied).toBe(false);
    expect(dry.reverted.map((r) => r.path)).toEqual(["f.txt"]);
    expect(read(p.root, "f.txt")).toContain("A3"); // dry run wrote nothing
    const r = plugin.core.revert({ agent: "A", apply: true });
    expect(r.applied).toBe(true);
    const txt = read(p.root, "f.txt");
    expect(txt).toContain("line 3\n");
    expect(txt).not.toContain("A3");
    expect(txt).toContain("B27");
    expect(read(p.root, "b.txt")).toBe("b\n");
    expect(r.alsoEditedByOthers[0].agents).toEqual(["B"]);
    expect(hist(p.root, "log", "-1", "--format=%B", "timeline")).toContain("Reverts-Agent: A");
    // the timeline tip equals the work tree afterwards
    expect(plugin.core.sweeper.dirtyPaths()).toEqual([]);
  });

  it("revert: overlapping hunks report a conflict and leave the file alone", async () => {
    const { plugin, events } = newPlugin();
    write(p.root, "f.txt", lines(10));
    events.emit("agent:newTask", { taskId: "A" });
    plugin.core.sweeper.sweep();
    await agentEdit(events, p.root, "A", "f.txt", read(p.root, "f.txt").replace("line 5\n", "A5\n"));
    await agentEdit(events, p.root, "B", "f.txt", read(p.root, "f.txt").replace("A5\n", "B5\n"));
    const before = manifest(p.root);
    const r = plugin.core.revert({ agent: "A", apply: true });
    expect(r.conflicts.map((c) => c.path)).toEqual(["f.txt"]);
    expect(r.reverted).toEqual([]);
    expect(diffManifest(before, manifest(p.root))).toEqual([]);
    expect(read(p.root, "f.txt")).toContain("B5");
  });

  it("revert: a file A created and B later edited conflicts; a file A created alone is deleted", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "shared.txt", "one\n");
    await agentEdit(events, p.root, "A", "mine.txt", "mine\n");
    await agentEdit(events, p.root, "B", "shared.txt", "one\ntwo\n");
    const r = plugin.core.revert({ agent: "A", apply: true });
    expect(r.conflicts.map((c) => c.path)).toContain("shared.txt");
    expect(fs.existsSync(path.join(p.root, "mine.txt"))).toBe(false);
    expect(read(p.root, "shared.txt")).toBe("one\ntwo\n");
    expect(r.reverted.find((x) => x.path === "mine.txt")?.action).toBe("delete");
  });

  it("revert: restores a file A deleted", async () => {
    const { plugin, events } = newPlugin();
    write(p.root, "gone.txt", "keep me\n");
    plugin.core.sweeper.sweep();
    events.emit("agent:newTask", { taskId: "A" });
    fs.rmSync(path.join(p.root, "gone.txt"));
    await events.emitBlocking("file:post-edit", { filePath: path.join(p.root, "gone.txt"), taskId: "A", operation: "write" });
    expect(plugin.core.history.log({ agent: "A" }).length).toBe(1);
    const r = plugin.core.revert({ agent: "A", apply: true });
    expect(r.applied).toBe(true);
    expect(read(p.root, "gone.txt")).toBe("keep me\n");
  });

  it("revert: --apply aborts per file when the file changed meanwhile (not recorded yet)", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "f.txt", "a\n");
    // simulate the race: the tip is swept inside revert(), so edit between sweep and write via a wrapped sweep
    const real = plugin.core.sweeper.sweep.bind(plugin.core.sweeper);
    (plugin.core.sweeper as any).sweep = (o: any) => {
      const r = real(o);
      write(p.root, "f.txt", "changed by someone, after the sweep\n");
      return r;
    };
    const r = plugin.core.revert({ agent: "A", apply: true });
    expect(r.changedMeanwhile).toEqual(["f.txt"]);
    expect(read(p.root, "f.txt")).toBe("changed by someone, after the sweep\n");
  });

  it("revert: exec commits are included; ambiguous ones are listed and skippable with exactOnly", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "x.txt", "old\n");
    await events.emitBlocking("exec:pre-run", { command: "sed one", taskId: "A", execId: "e1" });
    write(p.root, "x.txt", "new\n");
    await events.emitNonBlocking("tool:execCommand:done", { command: "sed one", taskId: "A", execId: "e1", exitCode: 0, background: false });
    // second exec overlaps with another agent's exec -> ambiguous
    await events.emitBlocking("exec:pre-run", { command: "gen one", taskId: "A", execId: "e2" });
    await events.emitBlocking("exec:pre-run", { command: "gen two", taskId: "B", execId: "e3" });
    write(p.root, "y.txt", "y\n");
    await events.emitNonBlocking("tool:execCommand:done", { command: "gen one", taskId: "A", execId: "e2", exitCode: 0, background: false });
    await events.emitNonBlocking("tool:execCommand:done", { command: "gen two", taskId: "B", execId: "e3", exitCode: 0, background: false });
    const dry = plugin.core.revert({ agent: "A", exactOnly: true });
    expect(dry.ambiguousSkipped.length).toBe(1);
    expect(dry.reverted.map((r) => r.path)).toContain("x.txt");
    expect(dry.reverted.map((r) => r.path)).not.toContain("y.txt");
    const all = plugin.core.revert({ agent: "A" });
    expect(all.ambiguousIncluded.length).toBe(1);
    expect(all.reverted.map((r) => r.path).sort()).toEqual(["x.txt", "y.txt"]);
    plugin.core.revert({ agent: "A", apply: true });
    expect(fs.existsSync(path.join(p.root, "x.txt"))).toBe(false);
    expect(fs.existsSync(path.join(p.root, "y.txt"))).toBe(false);
  });

  it("revert: ignored paths and paths untracked by policy are never written or deleted (design 12.4 test 4)", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "data/gen/a.json", '{"x":1}\n');
    await agentEdit(events, p.root, "A", "keep.txt", "k\n");
    write(p.root, ".gitignore", "node_modules\n.knowhow\ndata/gen/\n");
    events.emit("agent:newTask", { taskId: "C" }); // sweep -> untrack commit
    write(p.root, "data/gen/a.json", '{"x":2,"live":true}\n');
    const st0 = fs.statSync(path.join(p.root, "data/gen/a.json"));
    const r = plugin.core.revert({ agent: "A", apply: true });
    expect(r.skipped.map((s) => s.path)).toContain("data/gen/a.json");
    expect(read(p.root, "data/gen/a.json")).toBe('{"x":2,"live":true}\n');
    expect(fs.statSync(path.join(p.root, "data/gen/a.json")).mtimeMs).toBe(st0.mtimeMs);
    expect(fs.existsSync(path.join(p.root, "keep.txt"))).toBe(false); // the non-ignored file is reverted
  });

  it("what an agent sees works: the prompt block and the per-edit hint name commands that exist and work", async () => {
    const { plugin, events } = newPlugin();
    const msgs: string[] = [];
    events.on("agent:msg", (m: any) => msgs.push(String(m)));
    events.emit("agent:newTask", { taskId: "T1" });
    await agentEdit(events, p.root, "T1", "f.txt", "v1\n");
    await agentEdit(events, p.root, "T1", "f.txt", "v2\n");
    const block = await plugin.call("");
    for (const needle of ["knowhow history log --agent", "knowhow history restore <path>", "--at <sha>", "--before-agent", "knowhow history revert --agent", "--apply"]) {
      expect(block).toContain(needle);
    }
    const hint = msgs.find((m) => m.includes("restore this file"))!;
    expect(hint).toContain("knowhow history log --agent T1");
    expect(hint).toContain("knowhow history restore f.txt --apply");
    expect(hint).toContain("knowhow history revert --agent T1");
    // and the commands in the hint do what they say
    expect(plugin.core.history.log({ agent: "T1" }).length).toBe(2);
    expect(plugin.core.restore("f.txt", { apply: true }).status).toBe("restored");
    expect(read(p.root, "f.txt")).toBe("v1\n");
  });

  it("restore: dry run by default, --apply writes with fs, undoable; --at and --before-agent", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "f.txt", "v1\n");
    events.emit("agent:newTask", { taskId: "B" });
    await agentEdit(events, p.root, "B", "f.txt", "v2\n");
    await agentEdit(events, p.root, "B", "f.txt", "v3\n");
    const dry = plugin.core.restore("f.txt");
    expect(dry.status).toBe("would-restore");
    expect(read(p.root, "f.txt")).toBe("v3\n");
    const r = plugin.core.restore("f.txt", { apply: true });
    expect(r.status).toBe("restored");
    expect(read(p.root, "f.txt")).toBe("v2\n");
    const v1 = hist(p.root, "log", "--format=%H", "--grep=Agent: A", "-1", "timeline");
    expect(plugin.core.restore("f.txt", { at: v1, apply: true }).status).toBe("restored");
    expect(read(p.root, "f.txt")).toBe("v1\n");
    // the file already equals the version from before agent B first touched it
    expect(plugin.core.restore("f.txt", { beforeAgent: "B", apply: true }).status).toBe("unchanged");
    write(p.root, "f.txt", "someone else\n");
    expect(plugin.core.restore("f.txt", { beforeAgent: "B", apply: true }).status).toBe("restored");
    expect(read(p.root, "f.txt")).toBe("v1\n");
    // the file is "before agent A" = did not exist
    expect(plugin.core.restore("f.txt", { beforeAgent: "A", apply: true }).action).toBe("delete");
    expect(fs.existsSync(path.join(p.root, "f.txt"))).toBe(false);
    // an edit nobody recorded is swept first, so the restore is undoable
    write(p.root, "g.txt", "unrecorded\n");
    plugin.core.restore("g.txt");
    expect(hist(p.root, "ls-tree", "-r", "--name-only", "timeline")).toContain("g.txt");
    // outside the project
    expect(plugin.core.restore("/etc/hosts").status).toBe("refused");
  });

  it("restore refuses ignored paths and paths untracked by policy unless --force", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "data/gen/a.json", '{"x":1}\n');
    write(p.root, ".gitignore", "node_modules\n.knowhow\ndata/gen/\n");
    events.emit("agent:newTask", { taskId: "C" });
    write(p.root, "data/gen/a.json", "live\n");
    const r = plugin.core.restore("data/gen/a.json", { apply: true });
    expect(r.status).toBe("refused");
    expect(read(p.root, "data/gen/a.json")).toBe("live\n");
    // oversize: untracked by policy but not ignored
    await agentEdit(events, p.root, "A", "big.bin", "small\n");
    write(p.root, "big.bin", Buffer.alloc(26 * 1024 * 1024, 1));
    events.emit("agent:newTask", { taskId: "D" });
    const r2 = plugin.core.restore("big.bin", { apply: true });
    expect(r2.status).toBe("refused");
    expect(fs.statSync(path.join(p.root, "big.bin")).size).toBe(26 * 1024 * 1024);
    const r3 = plugin.core.restore("big.bin", { apply: true, force: true, at: hist(p.root, "log", "--format=%H", "-1", "--grep=Agent: A", "timeline") });
    expect(r3.status).toBe("restored");
    expect(read(p.root, "big.bin")).toBe("small\n");
  });

  it("reset: re-roots the timeline to one commit of the same tree; --drop-legacy refuses a fresh legacy ref, then drops with --force", async () => {
    const { plugin, events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    for (let i = 0; i < 5; i++) await agentEdit(events, p.root, "A", `f${i}.txt`, `${i}\n`);
    const tree = hist(p.root, "rev-parse", "timeline^{tree}");
    const dry = plugin.core.reset();
    expect(dry.applied).toBe(false);
    expect(hist(p.root, "rev-list", "--count", "timeline")).not.toBe("1");
    const r = plugin.core.reset({ apply: true });
    expect(r.applied).toBe(true);
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe("1");
    expect(hist(p.root, "rev-parse", "timeline^{tree}")).toBe(tree);
    expect(hist(p.root, "for-each-ref", "refs/knowhow/")).toBe("");
    // recording continues
    await agentEdit(events, p.root, "A", "after.txt", "x\n");
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe("2");
    // legacy refs
    hist(p.root, "update-ref", "refs/heads/task/old", hist(p.root, "rev-parse", "timeline"));
    const refused = plugin.core.reset({ apply: true, dropLegacy: true });
    expect(refused.refused).toMatch(/V1 process/);
    expect(hist(p.root, "for-each-ref", "refs/heads/task/")).toContain("task/old");
    const forced = plugin.core.reset({ apply: true, dropLegacy: true, force: true, pruneNow: true });
    expect(forced.droppedLegacy).toEqual(["refs/heads/task/old"]);
    expect(hist(p.root, "for-each-ref", "refs/heads/task/")).toBe("");
    expect(hist(p.root, "fsck", "--connectivity-only", "--no-dangling")).toBe("");
    expect(fs.existsSync(path.join(p.root, "after.txt"))).toBe(true);
  });
});

describe("knowhow history CLI through the compiled binary (status, show, log, diff, doctor, restore, revert, reset)", () => {
  jest.setTimeout(300000);
  const bin = process.env.KNOWHOW_HISTORY_BIN; // e.g. /tmp/knowhow-v2 (compiled outside ts_build); skipped when unset
  const maybe = bin ? it : it.skip;
  maybe("every subcommand works on a clone", async () => {
    const { execFileSync } = require("child_process");
    const p = makeProject("gv2cli-");
    try {
      const { plugin, events } = newPlugin();
      events.emit("agent:newTask", { taskId: "A" });
      await agentEdit(events, p.root, "A", "f.txt", "v1\n");
      await agentEdit(events, p.root, "A", "f.txt", "v2\n");
      const run = (...a: string[]) => execFileSync(bin!, ["history", ...a], { cwd: p.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(run("log", "--agent", "A")).toContain("edit: write f.txt");
      expect(JSON.parse(run("log", "--json", "-n", "5"))[0].agent).toBe("A");
      const st = run("status");
      expect(st).toMatch(/^tip [0-9a-f]{8}; swept 0 file\(s\)/);
      const sha = hist(p.root, "rev-parse", "timeline");
      expect(run("show", sha)).toContain("f.txt");
      expect(run("diff", "--agent", "A")).toContain("+v2");
      expect(JSON.parse(run("doctor", "--full")).ok).toBe(true);
      expect(run("restore", "f.txt")).toContain("would-restore");
      expect(read(p.root, "f.txt")).toBe("v2\n");
      expect(run("restore", "f.txt", "--apply")).toContain("restored");
      expect(read(p.root, "f.txt")).toBe("v1\n");
      expect(run("revert", "--agent", "A")).toContain("dry run");
      expect(run("revert", "--agent", "A", "--apply")).toContain("reverted");
      expect(fs.existsSync(path.join(p.root, "f.txt"))).toBe(false);
      expect(run("reset")).toContain("would reset");
      expect(run("reset", "--apply")).toContain("reset:");
      expect(hist(p.root, "rev-list", "--count", "timeline")).toBe("1");
    } finally {
      p.cleanup();
    }
  });
});
