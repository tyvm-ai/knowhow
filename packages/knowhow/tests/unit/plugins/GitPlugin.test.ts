import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { GitPlugin, escapeExcludePattern } from "../../../src/plugins/GitPlugin";
import { EventService } from "../../../src/services/EventService";
import { parseDuration } from "../../../src/services/AgentTaskCleanup";

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

const write = (root: string, rel: string, content: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

describe("GitPlugin hygiene", () => {
  let tmp: string;
  let prevCwd: string;
  let plugin: GitPlugin;

  const internal = (...args: string[]) =>
    execFileSync(
      "git",
      ["--git-dir", path.join(tmp, ".knowhow", ".git"), "--work-tree", tmp, ...args],
      { cwd: tmp, encoding: "utf8" }
    );
  const tracked = () => internal("ls-files").split("\n").filter(Boolean);

  beforeEach(() => {
    prevCwd = process.cwd();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gp-")));
    process.chdir(tmp);
    (GitPlugin as any).excludesReady.clear();
    plugin = new GitPlugin({ Events: new EventService() } as any);
    plugin.enable();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never tracks secrets, node_modules or .knowhow in a fresh internal repo", async () => {
    write(tmp, "a.txt", "a\n");
    write(tmp, ".env", "TOKEN=1\n");
    write(tmp, ".env.local", "TOKEN=2\n");
    write(tmp, "cert.pem", "x\n");
    write(tmp, "deep/priv.key", "x\n");
    write(tmp, "node_modules/x/index.js", "1\n");
    write(tmp, ".knowhow/prompts/p.md", "p\n");
    await (plugin as any).initializeKnowhowRepo();
    const files = tracked();
    expect(files).toContain("a.txt");
    for (const f of [".env", ".env.local", "cert.pem", "deep/priv.key", "node_modules/x/index.js", ".knowhow/prompts/p.md"]) {
      expect(files).not.toContain(f);
    }
  });

  it("untracks files that are now ignored", async () => {
    await (plugin as any).initializeKnowhowRepo();
    // simulate an older internal repo that tracked secrets
    fs.rmSync(path.join(tmp, ".knowhow", ".git", "info", "exclude"), { force: true });
    write(tmp, ".env", "TOKEN=1\n");
    write(tmp, "node_modules/x/index.js", "1\n");
    write(tmp, "keep.txt", "k\n");
    internal("add", "-f", "-A");
    internal("commit", "-q", "-m", "tracked secrets");
    expect(tracked()).toContain(".env");

    (GitPlugin as any).excludesReady.clear();
    plugin.ensureInternalExcludes();

    const files = tracked();
    expect(files).not.toContain(".env");
    expect(files).not.toContain("node_modules/x/index.js");
    expect(files).toContain("keep.txt");
    expect(internal("log", "-1", "--format=%s").trim()).toBe("untrack ignored files");
    // the file itself stays on disk
    expect(fs.existsSync(path.join(tmp, ".env"))).toBe(true);
  });

  it("skips files over gitPlugin.maxFileMb", async () => {
    write(tmp, ".knowhow/knowhow.json", JSON.stringify({ gitPlugin: { maxFileMb: 0.001 } }));
    await (plugin as any).initializeKnowhowRepo();
    write(tmp, "small.txt", "tiny\n");
    write(tmp, "weird [name].bin", "x".repeat(5000));
    await plugin.commitAll("add files");
    const files = tracked();
    expect(files).toContain("small.txt");
    expect(files).not.toContain("weird [name].bin");
  });

  it("keeps only the newest N task branches", async () => {
    write(tmp, ".knowhow/knowhow.json", JSON.stringify({ retention: { taskBranches: { keep: 2 } } }));
    await (plugin as any).initializeKnowhowRepo();
    for (let i = 1; i <= 4; i++) {
      internal("checkout", "-q", "-b", `task/t${i}`, "main");
      internal("commit", "-q", "--allow-empty", "-m", `c${i}`, "--date", `2020-01-0${i}T00:00:00`);
    }
    internal("checkout", "-q", "main");
    plugin.pruneTaskBranches();
    const branches = internal("branch", "--format=%(refname:short)")
      .split("\n")
      .filter((b) => b.startsWith("task/"));
    expect(branches.length).toBe(2);
  });

  it("escapes exclude patterns", () => {
    expect(escapeExcludePattern("a b.txt")).toBe("/a b.txt");
    expect(escapeExcludePattern("weird [x]*.bin")).toBe("/weird \\[x\\]\\*.bin");
    expect(escapeExcludePattern("#hash")).toBe("/\\#hash");
  });
});

describe("retention durations", () => {
  it("parses durations", () => {
    expect(parseDuration("3d")).toBe(3 * 24 * 3600 * 1000);
    expect(parseDuration("12h")).toBe(12 * 3600 * 1000);
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
    expect(parseDuration("nonsense")).toBeUndefined();
  });
});
