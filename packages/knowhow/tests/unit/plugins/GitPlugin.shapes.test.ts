import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { hist, makeProject, sh, write } from "./gitHelpers";
import { newV1 } from "./gitLegacy";
import { legacyState, takeover } from "./gitTakeover";

const git = (gd: string, args: string[]) =>
  execFileSync("git", ["--git-dir", gd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.c", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.c" } }).trim();

/** A project whose .knowhow/.git was built by the frozen old V1 plugin (legacyV1GitPlugin.fixture.ts): main + task/* history, HEAD on a task branch. */
async function v1History(root: string) {
  const v = newV1();
  write(root, "src/a.ts", "a\n");
  for (const id of ["h1", "h2"]) {
    await v.start(id);
    await v.edit(`src/${id}.ts`, `${id}\n`, root);
    await v.complete(id);
  }
  await v.start("h3");
  await v.edit("src/h3.ts", "h3\n", root);
}

describe("GitPlugin takeover on every V1 history shape (A2 fixtures)", () => {
  jest.setTimeout(300000);
  const made: ReturnType<typeof makeProject>[] = [];
  afterEach(() => { while (made.length) made.pop()!.cleanup(); });
  const proj = () => { const p = makeProject("gv2s-"); made.push(p); return p; };
  const initBare = (p: ReturnType<typeof makeProject>) => {
    fs.mkdirSync(path.join(p.root, ".knowhow"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: path.join(p.root, ".knowhow") });
  };

  const expectClean = (r: Awaited<ReturnType<typeof takeover>>) => {
    expect(r.workTreeChanged).toEqual([]);
    expect(r.legacyChanged).toEqual([]);
    expect(r.seeded).toBe(true);
    expect(r.recorded).toBe(true);
    expect(r.swept).toBe(true);
    expect(r.timelineOk).toBe(true);
  };

  it("V1 history made by the frozen old plugin (HEAD on task branch, main + task/*)", async () => {
    const p = proj();
    await v1History(p.root);
    expect(fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8")).toContain("task/h3");
    const head = git(p.gitDir, ["rev-parse", "HEAD"]);
    expectClean(await takeover(p.root));
    expect(git(p.gitDir, ["merge-base", "--is-ancestor", head, "timeline"])).toBe("");
    expect(git(p.gitDir, ["fsck", "--connectivity-only", "--no-dangling"])).toBe("");
  });

  it("unborn HEAD (init, no commits)", async () => {
    const p = proj();
    initBare(p);
    const r = await takeover(p.root);
    expectClean(r);
    expect(fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8")).toContain("refs/heads/");
  });

  it("HEAD on a deleted branch: timeline seeded from main", async () => {
    const p = proj();
    await v1History(p.root);
    const main = git(p.gitDir, ["rev-parse", "main"]);
    fs.writeFileSync(path.join(p.gitDir, "HEAD"), "ref: refs/heads/task/deleted\n");
    git(p.gitDir, ["update-ref", "-d", "refs/heads/task/h3"]);
    expectClean(await takeover(p.root));
    expect(git(p.gitDir, ["merge-base", "--is-ancestor", main, "timeline"])).toBe("");
  });

  it("an index.lock left behind by V1: untouched, V2 works", async () => {
    const p = proj();
    await v1History(p.root);
    fs.writeFileSync(path.join(p.gitDir, "index.lock"), "");
    const r = await takeover(p.root);
    expectClean(r);
    expect(fs.existsSync(path.join(p.gitDir, "index.lock"))).toBe(true);
  });

  it("packs only (git gc, no loose objects)", async () => {
    const p = proj();
    await v1History(p.root);
    git(p.gitDir, ["gc", "-q", "--prune=now"]);
    const loose = fs.readdirSync(path.join(p.gitDir, "objects")).filter((n) => /^[0-9a-f]{2}$/.test(n));
    expect(loose.length).toBe(0);
    expectClean(await takeover(p.root));
    expect(git(p.gitDir, ["fsck", "--connectivity-only", "--no-dangling"])).toBe("");
  });

  it("an empty .knowhow/.git directory", async () => {
    const p = proj();
    fs.mkdirSync(p.gitDir, { recursive: true });
    const r = await takeover(p.root);
    expect(r.workTreeChanged).toEqual([]);
    expect(r.seeded && r.recorded && r.swept && r.timelineOk).toBe(true);
  });

  it("no .knowhow/.git at all", async () => {
    const p = proj();
    expect(fs.existsSync(p.gitDir)).toBe(false);
    const r = await takeover(p.root);
    expect(r.workTreeChanged).toEqual([]);
    expect(r.seeded && r.recorded && r.swept && r.timelineOk).toBe(true);
    expect(git(p.gitDir, ["fsck", "--connectivity-only", "--no-dangling"])).toBe("");
  });

  it("a project that is not a git repository at all (no alternates possible)", async () => {
    const p = proj();
    fs.rmSync(path.join(p.root, ".git"), { recursive: true, force: true });
    const r = await takeover(p.root);
    expect(r.workTreeChanged).toEqual([]);
    expect(r.seeded && r.recorded && r.swept && r.timelineOk).toBe(true);
  });

  it("legacy fixture: legacyState() sees nothing from V2 afterwards, including a second takeover", async () => {
    const p = proj();
    await v1History(p.root);
    const before = legacyState(p.gitDir);
    await takeover(p.root);
    await takeover(p.root);
    expect(legacyState(p.gitDir)).toEqual(before);
    expect(hist(p.root, "log", "-1", "--format=%s", "timeline")).toBeTruthy();
    sh(p.root, "status", "--porcelain");
  });
});

describe("V1 after `history reset --drop-legacy` (HEAD points at a deleted branch)", () => {
  jest.setTimeout(300000);
  it("V1 can still start, edit and complete tasks and never touches work-tree files", async () => {
    const p = makeProject("gv2s-drop-");
    try {
      await v1History(p.root);
      const { newPlugin } = require("./gitHelpers");
      const { plugin, events } = newPlugin();
      events.emit("agent:newTask", { taskId: "A" });
      write(p.root, "live/keep.txt", "keep\n");
      plugin.core.sweeper.sweep();
      plugin.core.reset({ apply: true, dropLegacy: true, force: true });
      expect(fs.readFileSync(path.join(p.gitDir, "HEAD"), "utf8")).toContain("task/h3");
      const before = require("./gitHelpers").manifest(p.root);
      const v = newV1();
      await v.start("after1");
      await v.edit("src/after.ts", "x\n", p.root);
      await v.complete("after1");
      const after = require("./gitHelpers").manifest(p.root);
      const changed = require("./gitHelpers").diffManifest(before, after);
      expect(changed).toEqual(["src/after.ts"]);
      expect(fs.readFileSync(path.join(p.root, "live/keep.txt"), "utf8")).toBe("keep\n");
      expect(git(p.gitDir, ["rev-parse", "--verify", "timeline"]).length).toBe(40);
    } finally {
      process.chdir("/tmp");
      fs.rmSync(p.root, { recursive: true, force: true });
    }
  });
});
