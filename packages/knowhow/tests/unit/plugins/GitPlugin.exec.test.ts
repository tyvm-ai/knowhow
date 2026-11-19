import * as fs from "fs";
import * as path from "path";
import { agentEdit, hist, makeProject, newPlugin, write } from "./gitHelpers";

const log = (root: string, agent?: string) =>
  hist(root, "log", "--format=%H%x1f%B%x1e", ...(agent ? ["-E", `--grep=^Agent: ${agent}$`] : []), "timeline")
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean);

describe("GitPlugin phase 3: shell edits + doctor", () => {
  let p: ReturnType<typeof makeProject>;
  beforeEach(() => {
    p = makeProject("gv2e-");
  });
  afterEach(() => p.cleanup());

  const run = async (events: any, taskId: string, execId: string, command: string, mutate: () => void, extra: any = {}) => {
    await events.emitBlocking("exec:pre-run", { command, taskId, execId });
    mutate();
    await events.emitNonBlocking("tool:execCommand:done", { command, taskId, execId, exitCode: 0, background: false, ...extra });
  };

  it("sed -i style rewrite becomes an exec commit with exact attribution", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "x.txt", "old\n");
    await run(events, "A", "e1", "sed -i s/old/new/ x.txt", () => write(p.root, "x.txt", "new\n"));
    const top = log(p.root)[0];
    expect(top).toContain("exec: sed -i s/old/new/ x.txt");
    expect(top).toContain("Agent: A");
    expect(top).toContain("Kind: exec");
    expect(top).toContain("Attribution: exact");
    expect(hist(p.root, "show", "timeline:x.txt")).toBe("new");
  });

  it("read-only command and writes to ignored dirs produce no commit; no taskId is coped with", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await agentEdit(events, p.root, "A", "x.txt", "1\n");
    const n = hist(p.root, "rev-list", "--count", "timeline");
    await run(events, "A", "e1", "ls", () => {});
    await run(events, "A", "e2", "npm install", () => write(p.root, "node_modules/pkg/index.js", "1\n"));
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe(n);
    await run(events, undefined as any, "e3", "python gen.py", () => write(p.root, "gen.txt", "g\n"));
    expect(log(p.root)[0]).toContain("Agent: unknown");
  });

  it("pre-run sweep isolates a user edit from the command's own effects", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    write(p.root, "user.txt", "by the user\n");
    await run(events, "A", "e1", "gen", () => write(p.root, "gen.txt", "g\n"));
    const entries = log(p.root);
    const execC = entries.find((e) => e.includes("Kind: exec"))!;
    expect(execC).toContain("Agent: A");
    expect(hist(p.root, "show", "--name-only", "--format=", execC.split("\x1f")[0])).toBe("gen.txt");
    expect(entries.some((e) => e.includes("Agent: user") && e.includes("Kind: sweep"))).toBe(true);
    expect(hist(p.root, "ls-tree", "-r", "--name-only", "timeline")).toContain("user.txt");
  });

  it("two overlapping execs are labelled ambiguous with Also-Possible", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    events.emit("agent:newTask", { taskId: "B" });
    await events.emitBlocking("exec:pre-run", { command: "genA", taskId: "A", execId: "ea" });
    await events.emitBlocking("exec:pre-run", { command: "genB", taskId: "B", execId: "eb" });
    write(p.root, "a.txt", "a\n");
    write(p.root, "b.txt", "b\n");
    await events.emitNonBlocking("tool:execCommand:done", { command: "genA", taskId: "A", execId: "ea", background: false });
    await events.emitNonBlocking("tool:execCommand:done", { command: "genB", taskId: "B", execId: "eb", background: false });
    const a = log(p.root, "A")[0];
    expect(a).toContain("Attribution: ambiguous");
    expect(a).toContain("Also-Possible: B");
  });

  it("background launch records nothing; the next sweep picks the effects up as user", async () => {
    const { events, plugin } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    await events.emitBlocking("exec:pre-run", { command: "server &", taskId: "A", execId: "bg" });
    write(p.root, "late.txt", "x\n");
    const n = hist(p.root, "rev-list", "--count", "timeline");
    await events.emitNonBlocking("tool:execCommand:done", { command: "server &", taskId: "A", execId: "bg", background: true });
    expect(hist(p.root, "rev-list", "--count", "timeline")).toBe(n);
    plugin.core.sweeper.sweep();
    expect(log(p.root)[0]).toContain("Agent: user");
    expect(hist(p.root, "ls-tree", "-r", "--name-only", "timeline")).toContain("late.txt");
  });

  it("another agent's edit during an exec makes it ambiguous", async () => {
    const { events } = newPlugin();
    events.emit("agent:newTask", { taskId: "A" });
    events.emit("agent:newTask", { taskId: "B" });
    await events.emitBlocking("exec:pre-run", { command: "gen", taskId: "A", execId: "e1" });
    await agentEdit(events, p.root, "B", "b.txt", "b\n");
    write(p.root, "a.txt", "a\n");
    await events.emitNonBlocking("tool:execCommand:done", { command: "gen", taskId: "A", execId: "e1", background: false });
    const a = log(p.root, "A")[0];
    expect(a).toContain("Attribution: ambiguous");
    expect(a).toContain("Also-Possible: B");
    expect(hist(p.root, "show", "--name-only", "--format=", a.split("\x1f")[0])).toBe("a.txt");
  });

  it("doctor: stale gc.log removed, alternates written, corrupt repo moved aside and re-created", async () => {
    const { plugin } = newPlugin();
    plugin.ensureStarted();
    const alt = fs.readFileSync(path.join(p.gitDir, "objects", "info", "alternates"), "utf8").trim();
    expect(fs.realpathSync(alt)).toBe(fs.realpathSync(path.join(p.root, ".git", "objects")));
    const gc = path.join(p.gitDir, "gc.log");
    fs.writeFileSync(gc, "fatal: broken");
    const old = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(gc, old, old);
    expect(plugin.core.doctor.check().fixed).toContain("removed stale gc.log");
    expect(fs.existsSync(gc)).toBe(false);
    // fast probe is quick
    const t0 = Date.now();
    plugin.core.doctor.fastProbe();
    expect(Date.now() - t0).toBeLessThan(500);

    // corrupt: delete the tip tree object
    const tipTree = hist(p.root, "rev-parse", "timeline^{tree}");
    const loose = path.join(p.gitDir, "objects", tipTree.slice(0, 2), tipTree.slice(2));
    if (fs.existsSync(loose)) {
      fs.chmodSync(loose, 0o644);
      fs.rmSync(loose);
      const { plugin: p2 } = newPlugin(new (require("../../../src/services/EventService").EventService)());
      p2.ensureStarted();
      expect(p2.core.repaired).toBeTruthy();
      expect(fs.existsSync(p2.core.repaired!)).toBe(true);
      expect(hist(p.root, "fsck", "--connectivity-only", "--no-dangling")).toBe("");
    }
  });
});
