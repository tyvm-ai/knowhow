import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { execFileSync } from "child_process";
import {
  excludeReason,
  createTransportBundle,
  pushTask,
  planBaseBundle,
  configFilePrefixes,
  TransportClient,
} from "../../../src/services/TaskTransport";
import {
  getRealRepoInfo,
  normalizeOriginUrl,
} from "../../../src/services/RealRepo";

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = (root: string, rel: string, content: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

function makeSourceRepo(root: string) {
  run(root, "init", "-q", "-b", "main");
  write(root, "a.txt", "alpha\n");
  write(root, "b.txt", "bravo\n");
  write(root, "sub/c.txt", "charlie\n");
  write(root, ".env.example", "KEY=example\n");
  write(root, ".gitignore", "ignored.log\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "init");
  run(root, "remote", "add", "micah", "git@github.com:Org/Repo.git");
}

function makeWip(root: string) {
  write(root, "a.txt", "alpha changed\n");
  fs.rmSync(path.join(root, "b.txt"));
  write(root, "new.txt", "brand new\n");
  write(root, "sub/deep/d.txt", "delta\n");
  write(root, ".env.example", "KEY=SUPERSECRET-LOCAL\n"); // tracked but excluded
  write(root, ".env", "TOKEN=SUPERSECRET\n");
  write(root, "secret.pem", "-----BEGIN " + "PRIVATE KEY-----\n" // fake fixture, split to avoid the secret scanner);
  write(root, "ignored.log", "log\n");
  write(root, "node_modules/x/index.js", "module.exports=1\n");
  write(root, "big.bin", "x".repeat(5000));
  write(root, ".knowhow/prompts/p.md", "prompt\n");
}

/** The same steps the backend prep script runs on the target. */
function applyLikeBackend(
  clone: string,
  bundle: string,
  taskId: string,
  baseSha: string,
  commit: string
) {
  run(clone, "cat-file", "-e", `${baseSha}^{commit}`);
  run(
    clone,
    "fetch",
    "--quiet",
    bundle,
    `+refs/transport/${taskId}:refs/knowhow-transport/${taskId}`
  );
  run(clone, "checkout", "-q", "-f", "-B", `knowhow/task-${taskId.slice(0, 8)}`, baseSha);
  run(clone, "read-tree", "-u", "--reset", commit);
  run(clone, "reset", "-q");
}

/**
 * Verify like the backend script: scratch index (seeded from baseSha so
 * tracked-but-excluded paths keep their HEAD entry), `add -A` with the same
 * pathspec excludes, compare the tree with the transport commit's tree.
 */
function verifyTree(clone: string, baseSha: string, commit: string) {
  const idx = path.join(os.tmpdir(), `verify-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: clone, env, encoding: "utf8" }).trim();
  try {
    g("read-tree", baseSha);
    g("add", "-A", "--", ".", ":!.knowhow", ":!.env", ":!.env.*", ":!node_modules");
    return {
      actual: g("write-tree"),
      expected: run(clone, "rev-parse", `${commit}^{tree}`),
    };
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

describe("TaskTransport helpers", () => {
  it("excludes secrets and generated paths", () => {
    expect(excludeReason(".env")).toBeDefined();
    expect(excludeReason("pkg/.env.local")).toBeDefined();
    expect(excludeReason("a/b/key.pem")).toBeDefined();
    expect(excludeReason("id_rsa.pub")).toBeDefined();
    expect(excludeReason(".npmrc")).toBeDefined();
    expect(excludeReason(".aws/credentials")).toBeDefined();
    expect(excludeReason("web/node_modules/x.js")).toBeDefined();
    expect(excludeReason(".knowhow/prompts/a.md")).toBeDefined();
    expect(excludeReason("docs/vision/a.md", ["docs/vision"])).toBeDefined();
    expect(excludeReason("src/index.ts")).toBeUndefined();
    expect(excludeReason("environment.ts")).toBeUndefined();
  });

  it("normalizes origin urls", () => {
    expect(normalizeOriginUrl("git@github.com:Org/Repo.git")).toBe(
      "https://github.com/Org/Repo"
    );
    expect(normalizeOriginUrl("https://user:pw@GitHub.com/Org/Repo.git")).toBe(
      "https://github.com/Org/Repo"
    );
    expect(normalizeOriginUrl("ssh://git@github.com/Org/Repo.git")).toBe(
      "https://github.com/Org/Repo"
    );
  });

  it("maps config files[] localPaths relative to the git root", () => {
    const prefixes = configFilePrefixes("/r", "/r/pkg", [
      { localPath: "./docs/" },
      { localPath: "../../outside" },
    ]);
    expect(prefixes).toEqual(["pkg/docs"]);
  });
});

describe("transport snapshot round trip", () => {
  let tmp: string;
  let src: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));
    src = path.join(tmp, "src");
    fs.mkdirSync(src);
    makeSourceRepo(src);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("applies into a clone at baseSha with identical tree, no secrets, and never touches real index/HEAD", async () => {
    makeWip(src);
    const info = getRealRepoInfo(src)!;
    expect(info.remoteName).toBe("micah");
    const headBefore = run(src, "rev-parse", "HEAD");
    const statusBefore = run(src, "status", "--porcelain");
    const indexBefore = fs.readFileSync(path.join(src, ".git", "index"));

    // Simulate GitPlugin's internal repo
    const pluginGit = path.join(src, ".knowhow", ".git");
    fs.mkdirSync(path.join(src, ".knowhow"), { recursive: true });
    run(path.join(src, ".knowhow"), "init", "-q", "-b", "main");
    execFileSync(
      "git",
      ["--git-dir", pluginGit, "--work-tree", src, "commit", "-q", "--allow-empty", "-m", "plugin"],
      { cwd: src }
    );
    const pluginHead = run(src, "--git-dir", pluginGit, "rev-parse", "HEAD");
    const pluginIndexExists = fs.existsSync(path.join(pluginGit, "index"));
    const pluginIndexBefore = pluginIndexExists
      ? fs.readFileSync(path.join(pluginGit, "index"))
      : undefined;

    const taskId = "1234567890-task";
    const snap = await createTransportBundle({
      taskId,
      info,
      knowhowDir: path.join(src, ".knowhow"),
      maxFileMb: 0.001, // ~1 KB: big.bin (5 KB) is oversized
    });

    // real repo & plugin repo untouched
    expect(run(src, "rev-parse", "HEAD")).toBe(headBefore);
    expect(run(src, "status", "--porcelain")).toBe(statusBefore);
    expect(fs.readFileSync(path.join(src, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(run(src, "--git-dir", pluginGit, "rev-parse", "HEAD")).toBe(pluginHead);
    if (pluginIndexBefore) {
      expect(fs.readFileSync(path.join(pluginGit, "index")).equals(pluginIndexBefore)).toBe(true);
    }
    // transport ref lives in the internal repo, parent is real HEAD
    expect(run(src, "--git-dir", pluginGit, "rev-parse", `refs/transport/${taskId}^`)).toBe(headBefore);
    expect(snap.baseSha).toBe(headBefore);

    // manifest
    expect(snap.manifest.deleted).toBe(1); // b.txt
    expect(snap.manifest.added).toBe(2); // new.txt, sub/deep/d.txt
    expect(snap.manifest.changed).toBe(1); // a.txt (.env.example kept at HEAD)
    const excludedPaths = snap.manifest.excluded.map((e) => e.replace(/ \(.*\)$/, ""));
    expect(excludedPaths).toEqual(
      expect.arrayContaining([".env", "secret.pem", "big.bin", ".env.example"])
    );

    // apply into a clone at baseSha
    const clone = path.join(tmp, "clone");
    execFileSync("git", ["clone", "-q", src, clone]);
    applyLikeBackend(clone, snap.bundlePath, taskId, snap.baseSha, snap.commitSha);

    expect(run(clone, "rev-parse", "HEAD")).toBe(headBefore);
    expect(fs.readFileSync(path.join(clone, "a.txt"), "utf8")).toBe("alpha changed\n");
    expect(fs.existsSync(path.join(clone, "b.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(clone, "new.txt"), "utf8")).toBe("brand new\n");
    expect(fs.readFileSync(path.join(clone, "sub/deep/d.txt"), "utf8")).toBe("delta\n");
    // excluded / ignored
    for (const f of [".env", "secret.pem", "big.bin", "ignored.log", "node_modules", ".knowhow"]) {
      expect(fs.existsSync(path.join(clone, f))).toBe(false);
    }
    // tracked-but-excluded keeps the HEAD content, never the local secret
    expect(fs.readFileSync(path.join(clone, ".env.example"), "utf8")).toBe("KEY=example\n");

    // WIP shows up as uncommitted changes vs baseSha (same as on the source)
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: clone, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(status).toEqual(
      expect.arrayContaining([" M a.txt", " D b.txt", "?? new.txt", "?? sub/deep/"])
    );

    // verify: add -A tree equals the transport commit's tree
    const v = verifyTree(clone, snap.baseSha, snap.commitSha);
    expect(v.actual).toBe(v.expected);

    // secret content is nowhere in the transported objects
    const tree = run(clone, "ls-tree", "-r", "--name-only", snap.commitSha);
    expect(tree).not.toContain(".env\n");
    // git grep exits 1 when nothing matches
    expect(() =>
      execFileSync("git", ["grep", "-q", "SUPERSECRET", snap.commitSha], {
        cwd: clone,
        stdio: "pipe",
      })
    ).toThrow();
  });
});

describe("pushTask / base bundles with a mock backend", () => {
  let tmp: string;
  let src: string;
  let server: http.Server;
  let port: number;
  let uploads: Record<string, Buffer>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-push-"));
    src = path.join(tmp, "src");
    fs.mkdirSync(src);
    makeSourceRepo(src);
    uploads = {};
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        uploads[req.url || ""] = Buffer.concat(chunks);
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as any).port;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mockClient(existingBundles: any[] = []) {
    const calls: Record<string, any[]> = {};
    const rec = (n: string, v: any) => (calls[n] ||= []).push(v);
    const client: TransportClient = {
      resolveGitRepository: async (req) => {
        rec("resolve", req);
        return { id: "repo1", bundles: existingBundles };
      },
      createGitRepositoryBundle: async (repoId, req) => {
        rec("bundle", req);
        const id = `b${calls.bundle.length}`;
        return { bundleId: id, uploadUrl: `http://127.0.0.1:${port}/${id}` };
      },
      completeGitRepositoryBundle: async (_r, id) => rec("complete", id),
      upsertTaskWorkspace: async (t, req) => rec("workspace", { t, req }),
      createTaskWorkspaceSnapshot: async (t, req) => {
        rec("snapshot", { t, req });
        return { id: "s1", seq: 1 };
      },
      createTaskOffload: async () => ({ id: "o1", state: "requested" }),
      getTaskOffload: async () => ({ id: "o1", state: "running", log: [] }),
      getTaskWorkspace: async () => ({}),
    };
    return { client, calls };
  }

  it("uploads a full base bundle then the transport bundle, normalizing the remote url", async () => {
    makeWip(src);
    const { client, calls } = mockClient();
    const logs: string[] = [];
    await pushTask(client, "task-1", { cwd: src, log: (m) => logs.push(m), metadata: { model: "m1", agentName: "Patcher" } });

    expect(calls.resolve[0].originUrl).toBe("https://github.com/Org/Repo");
    expect(calls.workspace[0].req).toMatchObject({
      repositoryId: "repo1",
      baseSha: run(src, "rev-parse", "HEAD"),
      baseBranch: "main",
      runSettings: { model: "m1", agentName: "Patcher" },
    });
    expect(calls.bundle.map((b) => b.kind)).toEqual(["base", "transport"]);
    expect(calls.bundle[1].prerequisiteShas).toEqual([run(src, "rev-parse", "HEAD")]);
    expect(calls.complete).toEqual(["b1", "b2"]);
    expect(calls.snapshot[0].req.commitSha).toBe(calls.bundle[1].tipSha);
    expect(Object.keys(uploads).sort()).toEqual(["/b1", "/b2"]);
    expect(uploads["/b2"].length).toBe(calls.bundle[1].sizeBytes);
    // the uploaded transport bundle really is a git bundle
    const f = path.join(tmp, "t.bundle");
    fs.writeFileSync(f, uploads["/b2"]);
    expect(run(src, "bundle", "verify", f)).toContain("refs/transport/task-1");
  });

  it("skips the base upload when a ready bundle already covers HEAD and uploads an incremental otherwise", async () => {
    const head = run(src, "rev-parse", "HEAD");
    const covered = mockClient([{ id: "x", kind: "base", tipSha: head, status: "ready" }]);
    await pushTask(covered.client, "task-2", { cwd: src, log: () => {} });
    expect(covered.calls.bundle.map((b) => b.kind)).toEqual(["transport"]);

    // new commit on top -> incremental against the old tip
    write(src, "later.txt", "later\n");
    run(src, "add", "-A");
    run(src, "commit", "-q", "-m", "later");
    const info = getRealRepoInfo(src)!;
    const plan = planBaseBundle(info, [{ id: "x", kind: "base", tipSha: head, status: "ready" }]);
    expect(plan).toEqual({ covered: false, parentTip: head });

    const inc = mockClient([{ id: "x", kind: "base", tipSha: head, status: "ready" }]);
    await pushTask(inc.client, "task-3", { cwd: src, log: () => {} });
    expect(inc.calls.bundle.map((b) => b.kind)).toEqual(["incremental", "transport"]);
    expect(inc.calls.bundle[0].prerequisiteShas).toEqual([head]);
  });

  it("refuses repositories without a remote", async () => {
    run(src, "remote", "remove", "micah");
    const { client } = mockClient();
    await expect(pushTask(client, "task-4", { cwd: src, log: () => {} })).rejects.toThrow(/no remote/);
  });
});
