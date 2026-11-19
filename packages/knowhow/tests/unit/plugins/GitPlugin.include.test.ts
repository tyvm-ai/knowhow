import * as fs from "fs";
import * as path from "path";
import { TimelineCore } from "../../../src/plugins/gitplugin/Core";
import { IncludeSet, isSecretPath } from "../../../src/plugins/gitplugin/Include";
import { diffManifest, hist, makeProject, manifest, write } from "./gitHelpers";

const ls = (root: string) => hist(root, "ls-tree", "-r", "--name-only", "timeline").split("\n").filter(Boolean);

describe("gitPlugin.include: ignored paths that stay tracked (A6)", () => {
  jest.setTimeout(120000);
  let p: ReturnType<typeof makeProject>;
  let mk: (inc: string[], maxMb?: number) => TimelineCore;
  beforeEach(() => {
    p = makeProject("gv2inc-");
    write(p.root, ".gitignore", "node_modules\n.knowhow\nscripts/tmp/*\ndata/generator/\nother/\n");
    mk = (inc, maxMb) => new TimelineCore({ root: p.root, include: () => inc, maxFileMb: () => maxMb });
  });
  afterEach(() => p.cleanup());

  it("pattern matching: dirs, globs, secrets and dependencies never match", () => {
    const s = new IncludeSet(p.root, () => ["scripts/tmp/**", "data/generator/", "notes/*.md", "single.txt"]);
    expect(s.isIncluded("scripts/tmp/a/b.ts")).toBe(true);
    expect(s.isIncluded("data/generator/x.json")).toBe(true);
    expect(s.isIncluded("notes/a.md")).toBe(true);
    expect(s.isIncluded("notes/sub/a.md")).toBe(false);
    expect(s.isIncluded("single.txt")).toBe(true);
    expect(s.isIncluded("other/x")).toBe(false);
    expect(s.isIncluded("scripts/tmp/.env")).toBe(false);
    expect(s.isIncluded("scripts/tmp/k.pem")).toBe(false);
    expect(s.isIncluded("data/generator/node_modules/x.js")).toBe(false);
    expect(isSecretPath("a/.env.local")).toBe(true);
    // escaping the project is rejected
    expect(new IncludeSet(p.root, () => ["../etc", "/etc"]).enabled).toBe(false);
  });

  it("without the key the ignored paths are not tracked (control)", () => {
    const c = mk([]);
    c.start();
    write(p.root, "scripts/tmp/a.ts", "a\n");
    write(p.root, "src/x.ts", "x\n");
    c.sweeper.sweep();
    expect(ls(p.root)).toContain("src/x.ts");
    expect(ls(p.root)).not.toContain("scripts/tmp/a.ts");
  });

  it("with the key: new, changed and deleted files in included ignored paths are swept, nothing else ignored is", () => {
    write(p.root, "scripts/tmp/seed.ts", "seed\n");
    write(p.root, "data/generator/run1.json", "{}\n");
    write(p.root, "other/ignored.txt", "no\n");
    write(p.root, "node_modules/dep/index.js", "dep\n");
    const c = mk(["scripts/tmp/**", "data/generator/"]);
    c.start();
    expect(ls(p.root)).toEqual(expect.arrayContaining(["scripts/tmp/seed.ts", "data/generator/run1.json"]));
    expect(ls(p.root)).not.toContain("other/ignored.txt");
    expect(ls(p.root).some((f) => f.startsWith("node_modules"))).toBe(false);
    write(p.root, "scripts/tmp/seed.ts", "seed2\n");
    write(p.root, "scripts/tmp/deep/new.ts", "new\n");
    fs.rmSync(path.join(p.root, "data/generator/run1.json"));
    const r = c.sweeper.sweep();
    expect(r.swept.sort()).toEqual(["data/generator/run1.json", "scripts/tmp/deep/new.ts", "scripts/tmp/seed.ts"]);
    expect(hist(p.root, "show", "timeline:scripts/tmp/seed.ts")).toBe("seed2");
    expect(ls(p.root)).not.toContain("data/generator/run1.json");
    // no untrack commit for included paths even though the project ignores them
    expect(hist(p.root, "log", "--format=%H", "-E", "--grep=^Kind: untrack$", "timeline")).toBe("");
    // a second sweep with nothing changed records nothing
    expect(c.sweeper.sweep().swept).toEqual([]);
  });

  it("an edit event on an included, ignored path is recorded; an edit outside the include list is skipped", async () => {
    const c = mk(["scripts/tmp/**"]);
    c.start();
    write(p.root, "scripts/tmp/e.ts", "e\n");
    write(p.root, "other/e.txt", "e\n");
    const f = c.policy.filter(["scripts/tmp/e.ts", "other/e.txt"]);
    expect(f.keep).toEqual(["scripts/tmp/e.ts"]);
    expect(f.skippedIgnored).toEqual(["other/e.txt"]);
    const r = c.recorder.recordChange({ agent: "A", kind: "edit", summary: "x", paths: f.keep });
    expect(r.sha).toBeTruthy();
  });

  it("size cap and secret filter still apply inside included paths", () => {
    write(p.root, "scripts/tmp/big.bin", Buffer.alloc(3 * 1024 * 1024, 1));
    write(p.root, "scripts/tmp/small.ts", "s\n");
    write(p.root, "scripts/tmp/.env", "TOKEN=1\n");
    write(p.root, "scripts/tmp/key.pem", "x\n");
    const c = mk(["scripts/tmp/**"], 1);
    const r = c.start();
    expect(r.sweep.skippedOversize).toEqual(["scripts/tmp/big.bin"]);
    expect(ls(p.root).filter((f) => f.startsWith("scripts/tmp/")).sort()).toEqual(["scripts/tmp/small.ts"]);
  });

  it("a file in an included path that later grows past the cap is untracked by the oversize rule (not exempt), and stays on disk", () => {
    write(p.root, "scripts/tmp/grow.bin", "small\n");
    const c = mk(["scripts/tmp/**"], 1);
    c.start();
    expect(ls(p.root)).toContain("scripts/tmp/grow.bin");
    write(p.root, "scripts/tmp/grow.bin", Buffer.alloc(2 * 1024 * 1024, 1));
    const r = c.sweeper.sweep();
    expect(r.untracked).toEqual(["scripts/tmp/grow.bin"]);
    expect(fs.statSync(path.join(p.root, "scripts/tmp/grow.bin")).size).toBe(2 * 1024 * 1024);
  });

  it("exempt from the untrack policy: tracked included files survive a new ignore rule; the work tree never changes", () => {
    write(p.root, "data/generator/a.json", "{}\n");
    const c = mk(["data/generator/"]);
    c.start();
    expect(ls(p.root)).toContain("data/generator/a.json");
    write(p.root, ".gitignore", "node_modules\n.knowhow\nscripts/tmp/*\ndata/\n");
    const before = manifest(p.root);
    const r = c.sweeper.sweep();
    expect(r.untracked).toEqual([]);
    expect(ls(p.root)).toContain("data/generator/a.json");
    expect(diffManifest(before, manifest(p.root))).toEqual([]);
  });

  it("walking is bounded to the include roots: ignored trees elsewhere are never listed", () => {
    for (let i = 0; i < 50; i++) write(p.root, `node_modules/m${i}/index.js`, "x\n");
    write(p.root, "scripts/tmp/a.ts", "a\n");
    const s = new IncludeSet(p.root, () => ["scripts/tmp/**"]);
    expect(s.walk()).toEqual(["scripts/tmp/a.ts"]);
    expect(s.roots()).toEqual(["scripts/tmp"]);
  });
});
