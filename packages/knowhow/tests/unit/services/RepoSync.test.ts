import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  pushRepo,
  pullRepo,
  repoStatus,
  initHostedRepo,
  normalizeRefs,
  tipFromBundles,
  readFetchedBundles,
  conflictCurrentSha,
  hostedRepoName,
  isConflictStatus,
  RepoClient,
} from "../../../src/services/RepoSync";
import { getRealRepoInfo, normalizeOriginUrl } from "../../../src/services/RealRepo";

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// hosted urls are `knowhow://<orgId>/<name>` (the backend lowercases them)
const ORIGIN = "knowhow://0b6f1c2e-1111-4222-8333-444455556666/demo";

/** In-memory stand-in for the backend: stores bundle files by id, enforces the CAS on expectedTip. */
class FakeBackend {
  bundles: { id: string; kind: string; tipSha: string; refs: { name: string; sha: string }[]; status: string }[] = [];
  files = new Map<string, string>();
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-backend-"));
  /** when set, the next createGitRepositoryBundle call simulates somebody else pushing first */
  beforeNextCreate?: () => void;
  createCalls: any[] = [];
  seq = 0;

  tip(ref: string): string | null {
    let t: string | null = null;
    for (const b of this.bundles) if (b.status === "ready") for (const r of b.refs) if (r.name === ref) t = r.sha;
    return t;
  }

  client(): RepoClient {
    const self = this;
    return {
      async resolveGitRepository() {
        return { id: "repo-1", bundles: self.bundles as any };
      },
      async createHostedGitRepository(name: string) {
        return { id: "repo-1", name, originUrl: ORIGIN, bundles: [] };
      },
      async getGitRepository() {
        return { id: "repo-1", bundles: self.bundles as any };
      },
      async getGitRepositoryRefs() {
        const refs: Record<string, string> = {};
        for (const b of self.bundles) if (b.status === "ready") for (const r of b.refs) refs[r.name] = r.sha;
        return refs;
      },
      async createGitRepositoryBundle(_id: string, req: any) {
        self.createCalls.push(req);
        if (self.beforeNextCreate) {
          const f = self.beforeNextCreate;
          self.beforeNextCreate = undefined;
          f();
        }
        if (req.expectedTip && self.tip(req.expectedTip.ref) !== req.expectedTip.sha) {
          // what utils/http HttpError carries for the backend's AppError({ currentSha }, msg, 409)
          const err: any = new Error('HTTP 409: {"error":{"message":"Branch tip changed","details":{"currentSha":"x"}}}');
          err.name = "HttpError";
          err.status = 409;
          err.body = {
            error: {
              message: "Branch tip changed: expected tip does not match the current tip",
              details: { currentSha: self.tip(req.expectedTip.ref) },
            },
          };
          throw err;
        }
        const id = `bundle-${++self.seq}`;
        self.bundles.push({ id, kind: req.kind, tipSha: req.tipSha, refs: req.refs, status: "pending" });
        return { bundleId: id, uploadUrl: `mem://${id}` };
      },
      async completeGitRepositoryBundle(_r: string, bundleId: string) {
        self.bundles.find((b) => b.id === bundleId)!.status = "ready";
        return {};
      },
      async getGitBundleDownloadUrl(_r: string, bundleId: string) {
        return { url: `mem://${bundleId}` };
      },
    } as unknown as RepoClient;
  }
}

let backend: FakeBackend;
let putSpy: jest.SpyInstance;

beforeEach(() => {
  backend = new FakeBackend();
  // uploads: fetch(PUT mem://id, body) -> keep the bytes
  putSpy = jest.spyOn(global, "fetch" as any).mockImplementation((async (url: string, init: any) => {
    const id = String(url).replace("mem://", "");
    const f = path.join(backend.uploadsDir, id + ".bundle");
    fs.writeFileSync(f, init.body);
    backend.files.set(id, f);
    return { ok: true, status: 200, text: async () => "" } as any;
  }) as any);
});
afterEach(() => putSpy.mockRestore());

const download = async (url: string, dest: string) => {
  const id = url.replace("mem://", "");
  fs.copyFileSync(backend.files.get(id)!, dest);
};

function tmp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepo(root: string, files: Record<string, string> = { "a.txt": "alpha\n" }) {
  run(root, "init", "-q", "-b", "main");
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(root, k), v);
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "init");
  run(root, "remote", "add", "knowhow", ORIGIN);
}

function commitFile(root: string, name: string, content: string, msg = `add ${name}`) {
  fs.writeFileSync(path.join(root, name), content);
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", msg);
  return run(root, "rev-parse", "HEAD");
}

describe("knowhow:// remotes", () => {
  it("normalizeOriginUrl keeps knowhow:// URLs", () => {
    expect(normalizeOriginUrl("knowhow://acme/demo/")).toBe("knowhow://acme/demo");
    expect(normalizeOriginUrl("git@github.com:Org/Repo.git")).toBe("https://github.com/Org/Repo");
  });

  it("getRealRepoInfo picks the knowhow remote when it is the only one", () => {
    const root = tmp("repo-info-");
    makeRepo(root);
    const info = getRealRepoInfo(root)!;
    expect(info.remoteName).toBe("knowhow");
    expect(info.remoteUrl).toBe(ORIGIN);
  });

  it("prefers origin over knowhow by default", () => {
    const root = tmp("repo-origin-");
    makeRepo(root);
    run(root, "remote", "add", "origin", "git@github.com:Org/Repo.git");
    expect(getRealRepoInfo(root)!.remoteName).toBe("origin");
    expect(getRealRepoInfo(root, "knowhow")!.remoteName).toBe("knowhow");
  });
});

describe("backend contract helpers", () => {
  it("normalizeOriginUrl lowercases hosted urls like the backend (orgId/name)", () => {
    expect(normalizeOriginUrl("knowhow://0B6F-AA/My-Repo.git/")).toBe("knowhow://0b6f-aa/my-repo");
  });

  it("conflictCurrentSha reads error.details.currentSha of a 409 (string, null, or unknown)", () => {
    const mk = (details: any) => Object.assign(new Error("HTTP 409"), { status: 409, body: { error: { message: "m", details } } });
    expect(isConflictStatus(mk({}))).toBe(true);
    expect(conflictCurrentSha(mk({ currentSha: "a".repeat(40) }))).toBe("a".repeat(40));
    expect(conflictCurrentSha(mk({ currentSha: null }))).toBeNull();
    expect(conflictCurrentSha(mk({}))).toBeUndefined();
    expect(conflictCurrentSha(new Error("boom"))).toBeUndefined();
  });

  it("hostedRepoName follows the backend name rule (strict for --name, sanitised for the directory name)", () => {
    expect(hostedRepoName("my.repo_1-x", true)).toBe("my.repo_1-x");
    expect(() => hostedRepoName("my repo", true)).toThrow(/Invalid repository name/);
    expect(() => hostedRepoName("..", true)).toThrow();
    expect(hostedRepoName("my repo (copy)", false)).toBe("my-repo-copy");
    expect(() => hostedRepoName("###", false)).toThrow(/pass --name/);
  });
});

describe("helpers", () => {
  it("normalizeRefs accepts several shapes", () => {
    const sha = "a".repeat(40);
    expect(normalizeRefs({ "refs/heads/main": sha })).toEqual({ "refs/heads/main": sha });
    expect(normalizeRefs({ headRefs: { "refs/heads/main": sha } })).toEqual({ "refs/heads/main": sha });
    expect(normalizeRefs([{ name: "refs/heads/x", sha }])).toEqual({ "refs/heads/x": sha });
    expect(normalizeRefs(undefined)).toEqual({});
  });

  it("tipFromBundles: newest ready bundle with the ref wins", () => {
    const b = (id: string, sha: string, status = "ready", kind = "incremental") => ({
      id, kind, tipSha: sha, status, refs: [{ name: "refs/heads/main", sha }],
    });
    expect(tipFromBundles([b("1", "s1", "ready", "base"), b("2", "s2"), b("3", "s3", "pending")], "refs/heads/main")).toBe("s2");
    expect(tipFromBundles([], "refs/heads/main")).toBeNull();
  });
});

describe("initHostedRepo / pushRepo", () => {
  it("init --hosted adds the remote and uploads a base bundle", async () => {
    const root = tmp("repo-init-");
    run(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "init");
    const sha = run(root, "rev-parse", "HEAD");

    const r = await initHostedRepo(backend.client(), { cwd: root, name: "demo" });
    expect(r.originUrl).toBe(ORIGIN);
    expect(run(root, "remote", "get-url", "knowhow")).toBe(ORIGIN);
    expect(backend.createCalls).toHaveLength(1);
    expect(backend.createCalls[0]).toMatchObject({ kind: "base", tipSha: sha });
    expect(backend.createCalls[0].refs).toEqual([{ name: "refs/heads/main", sha }]);
    expect(backend.tip("refs/heads/main")).toBe(sha);
  });

  it("push sends an incremental bundle <branch> ^<tip> with expectedTip", async () => {
    const root = tmp("repo-push-");
    makeRepo(root);
    await pushRepo(backend.client(), { cwd: root }); // first push: full bundle, expectedTip.sha null
    expect(backend.createCalls[0]).toMatchObject({ kind: "base", expectedTip: { ref: "refs/heads/main", sha: null } });
    const first = run(root, "rev-parse", "HEAD");

    const second = commitFile(root, "b.txt", "bravo\n");
    const r = await pushRepo(backend.client(), { cwd: root });
    expect(r).toMatchObject({ status: "pushed", sha: second, previousTip: first });
    const req = backend.createCalls[1];
    expect(req).toMatchObject({
      kind: "incremental",
      tipSha: second,
      prerequisiteShas: [first],
      expectedTip: { ref: "refs/heads/main", sha: first },
    });
    // the uploaded bundle only needs the previous tip
    const bundleFile = backend.files.get(r.bundleId!)!;
    const head = run(root, "bundle", "list-heads", bundleFile);
    expect(head).toContain(second);
    const verify = run(root, "bundle", "verify", bundleFile);
    expect(verify).toContain("requires this ref");
    expect(verify).toContain(first);
  });

  it("push with nothing new is a no-op", async () => {
    const root = tmp("repo-noop-");
    makeRepo(root);
    await pushRepo(backend.client(), { cwd: root });
    const calls = backend.createCalls.length;
    const r = await pushRepo(backend.client(), { cwd: root });
    expect(r.status).toBe("up-to-date");
    expect(backend.createCalls).toHaveLength(calls);
  });
});

describe("CAS conflict + pull", () => {
  /** Two clones of the same hosted repo; `other` pushes first. */
  async function twoClones() {
    const a = tmp("repo-a-");
    makeRepo(a);
    await pushRepo(backend.client(), { cwd: a });
    const b = tmp("repo-b-");
    run(b, "init", "-q", "-b", "main");
    run(b, "remote", "add", "knowhow", ORIGIN);
    const pulled = await pullRepo(backend.client(), { cwd: b, download });
    expect(pulled.status).toBe("created");
    return { a, b };
  }

  it("pull downloads the chain, caches bundle ids, and fast-forwards", async () => {
    const { a, b } = await twoClones();
    expect(run(b, "rev-parse", "main")).toBe(run(a, "rev-parse", "main"));
    expect(readFetchedBundles(run(b, "rev-parse", "--show-toplevel"), "repo-1").size).toBe(1);

    const next = commitFile(a, "n.txt", "n\n");
    await pushRepo(backend.client(), { cwd: a });
    const messages: string[] = [];
    const r = await pullRepo(backend.client(), { cwd: b, download, log: (m) => messages.push(m) });
    expect(r).toMatchObject({ status: "fast-forwarded", fetchedBundles: 1 });
    expect(run(b, "rev-parse", "main")).toBe(next);
    expect(fs.readFileSync(path.join(b, "n.txt"), "utf8")).toBe("n\n"); // working tree updated (merge --ff-only)

    // second pull: nothing new is downloaded (cache)
    const again = await pullRepo(backend.client(), { cwd: b, download });
    expect(again).toMatchObject({ status: "up-to-date", fetchedBundles: 0 });
  });

  it("409 on push: pulls, rebases onto the new tip and retries once", async () => {
    const { a, b } = await twoClones();
    // b has a local commit; a pushes first -- but b's tip lookup happens before, so simulate the race
    // by making `a` push right when b starts creating its bundle.
    const local = commitFile(b, "b-only.txt", "b\n");
    const remoteNew = commitFile(a, "a-only.txt", "a\n");
    backend.beforeNextCreate = undefined;
    const client = backend.client();
    let raced = false;
    backend.beforeNextCreate = () => {
      raced = true;
      return;
    };
    // a pushes after b computed the tip (inside the create call)
    const origCreate = client.createGitRepositoryBundle.bind(client);
    let aPushed = false;
    (client as any).createGitRepositoryBundle = async (id: string, req: any) => {
      if (!aPushed) {
        aPushed = true;
        await pushRepo(backend.client(), { cwd: a });
      }
      return origCreate(id, req);
    };
    const messages: string[] = [];
    const r = await pushRepo(client, { cwd: b, download, log: (m) => messages.push(m) });
    expect(raced).toBe(true);
    expect(r.status).toBe("pushed");
    expect(r.rebased).toBe(true);
    expect(messages.some((m) => m.includes("409") && /moved to [0-9a-f]{8}/.test(m))).toBe(true); // currentSha from error.details
    // b's commit now sits on top of a's
    const log = run(b, "log", "--format=%H", "main").split("\n");
    expect(log[1]).toBe(remoteNew);
    expect(log[0]).not.toBe(local); // rebased => new sha
    expect(backend.tip("refs/heads/main")).toBe(log[0]);
    expect(fs.existsSync(path.join(b, "a-only.txt"))).toBe(true);
    expect(fs.existsSync(path.join(b, "b-only.txt"))).toBe(true);
  });

  it("diverged tip found before pushing: pulls + rebases without a failed upload", async () => {
    const { a, b } = await twoClones();
    commitFile(b, "b-only.txt", "b\n");
    commitFile(a, "a-only.txt", "a\n");
    await pushRepo(backend.client(), { cwd: a });
    const before = backend.createCalls.length;
    const r = await pushRepo(backend.client(), { cwd: b, download });
    expect(r.status).toBe("pushed");
    expect(r.rebased).toBe(true);
    expect(backend.createCalls.length).toBe(before + 1); // one upload, no 409
  });

  it("rebase conflict: aborts, leaves the branch untouched, raises RepoConflictError", async () => {
    const { a, b } = await twoClones();
    const localSha = commitFile(b, "a.txt", "from b\n");
    commitFile(a, "a.txt", "from a\n");
    await pushRepo(backend.client(), { cwd: a });
    await expect(pushRepo(backend.client(), { cwd: b, download })).rejects.toThrow(/conflicts/);
    expect(run(b, "rev-parse", "main")).toBe(localSha);
    expect(run(b, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(b, ".git", "rebase-merge"))).toBe(false);
  });

  it("status reports in-sync / ahead / behind", async () => {
    const { a, b } = await twoClones();
    expect((await repoStatus(backend.client(), { cwd: b })).state).toBe("in-sync");
    commitFile(b, "x.txt", "x\n");
    const ahead = await repoStatus(backend.client(), { cwd: b });
    expect(ahead).toMatchObject({ state: "ahead", ahead: 1 });
    await pushRepo(backend.client(), { cwd: b });
    await pullRepo(backend.client(), { cwd: a, download });
    expect((await repoStatus(backend.client(), { cwd: a })).state).toBe("in-sync");
  });
});
