import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { listLines, parsePushSpec } from "../../../src/services/GitRemoteHelper";

describe("git-remote-knowhow protocol pieces", () => {
  test("parsePushSpec", () => {
    expect(parsePushSpec("refs/heads/main:refs/heads/main")).toEqual({ force: false, src: "refs/heads/main", dst: "refs/heads/main" });
    expect(parsePushSpec("+HEAD:refs/heads/x")).toEqual({ force: true, src: "HEAD", dst: "refs/heads/x" });
    expect(parsePushSpec(":refs/heads/gone")).toEqual({ force: false, src: "", dst: "refs/heads/gone" });
  });

  test("listLines advertises refs and a HEAD symref (default branch, else main)", () => {
    const refs = { "refs/heads/main": "a".repeat(40), "refs/heads/dev": "b".repeat(40) };
    expect(listLines(refs)).toEqual([`${"b".repeat(40)} refs/heads/dev`, `${"a".repeat(40)} refs/heads/main`, "@refs/heads/main HEAD"]);
    expect(listLines(refs, "dev").pop()).toBe("@refs/heads/dev HEAD");
    expect(listLines({})).toEqual([]);
  });
});

/** Real git driving the helper (tests/helpers/fakeRemoteHelper.ts) against a file-backed fake backend. */
describe("git-remote-knowhow end to end", () => {
  const pkg = path.resolve(__dirname, "../../..");
  const tsNode = [path.join(pkg, "node_modules/.bin/ts-node"), path.join(pkg, "../../node_modules/.bin/ts-node")].find((p) =>
    fs.existsSync(p)
  )!;
  let root: string;
  let env: NodeJS.ProcessEnv;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitFails = (cwd: string, ...args: string[]) => {
    try {
      git(cwd, ...args);
    } catch (e: any) {
      return String(e.stderr);
    }
    throw new Error(`git ${args.join(" ")} succeeded`);
  };
  const commit = (cwd: string, file: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, file), msg + "\n");
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", msg);
    return git(cwd, "rev-parse", "HEAD");
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "git-remote-knowhow-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "fake"));
    const shim = path.join(root, "bin", "git-remote-knowhow");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${tsNode}" --transpile-only "${path.join(pkg, "tests/helpers/fakeRemoteHelper.ts")}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    env = {
      ...process.env,
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
      FAKE_KNOWHOW_DIR: path.join(root, "fake"),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test("push, clone, pull, rejected stale push, pull --rebase, force push, branches", () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    git(root, "init", "-q", "-b", "main", a);
    const one = commit(a, "f", "one");
    git(a, "remote", "add", "origin", "knowhow://org/demo");
    git(a, "push", "-q", "-u", "origin", "main");

    git(root, "clone", "-q", "knowhow://org/demo", b);
    expect(git(b, "rev-parse", "HEAD")).toBe(one);
    expect(git(b, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");

    const two = commit(a, "f", "two");
    git(a, "push", "-q");
    git(b, "pull", "-q", "--ff-only");
    expect(git(b, "rev-parse", "HEAD")).toBe(two);

    // both commit; b pushes first, a is rejected and has to integrate
    const three = commit(b, "g", "three");
    commit(a, "h", "diverge");
    git(b, "push", "-q");
    expect(gitFails(a, "push")).toMatch(/rejected/);
    git(a, "pull", "-q", "--rebase");
    git(a, "push", "-q");
    const rebased = git(a, "rev-parse", "HEAD");
    expect(git(a, "rev-parse", "HEAD~1")).toBe(three);
    expect(git(b, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0]).toBe(rebased);

    // force push from b (which has not seen a's rebased commit) replaces the tip
    commit(b, "i", "forced");
    expect(gitFails(b, "push")).toMatch(/rejected/);
    git(b, "push", "-q", "--force");
    expect(git(a, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0]).toBe(git(b, "rev-parse", "HEAD"));

    // new branches work, deletes are refused
    git(b, "push", "-q", "origin", "HEAD:feature");
    expect(git(a, "ls-remote", "origin")).toMatch(/refs\/heads\/feature/);
    expect(gitFails(b, "push", "origin", ":feature")).toMatch(/deleting branches is not supported/);

    // `knowhow repo` bookkeeping stays in sync: the tracking ref the helper maintains matches
    expect(git(b, "rev-parse", "refs/knowhow-base/heads/main")).toBe(git(b, "rev-parse", "HEAD"));
  }, 180000);
});
