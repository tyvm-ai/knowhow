import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import * as RepoSync from "../../../src/services/RepoSync";
import {
  AppClient,
  AppPushError,
  appHistory,
  appStatus,
  contentTypeFor,
  developApp,
  envUrl,
  frontendBaseUrl,
  hashBuildFiles,
  linkAppSource,
  parseEnvPairs,
  promoteApp,
  publishApp,
  pushSourceIfKnowhowRepo,
  resolveAppId,
  rollbackApp,
  setAppSource,
  setEnvDataMode,
  setEnvVars,
  unsetEnvVars,
} from "../../../src/services/AppPublish";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const APP_ID = "11111111-2222-3333-4444-555555555555";
const REPO_ID = "99999999-8888-7777-6666-555555555555";

function makeApp(manifest: Record<string, unknown> = {}, files: Record<string, string> = { "index.html": "<html/>", "assets/a.js": "console.log(1)" }) {
  const dir = tmp("app-publish-");
  fs.writeFileSync(
    path.join(dir, "knowhow.app.json"),
    JSON.stringify({ slug: "demo", name: "Demo", build: { command: "npm run build", outputDir: "dist" }, ...manifest })
  );
  for (const [k, v] of Object.entries(files)) {
    const f = path.join(dir, "dist", k);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, v);
  }
  return dir;
}

function mockClient(over: Partial<Record<keyof AppClient, any>> = {}) {
  const calls: string[] = [];
  const c = {
    resolveApp: jest.fn(async () => {
      calls.push("resolve");
      return { id: APP_ID, slug: "demo", appOrigin: `https://demo--${"a".repeat(32)}.apps.example.com` };
    }),
    listApps: jest.fn(async () => [{ id: APP_ID, slug: "demo" }]),
    getApp: jest.fn(async () => ({ id: APP_ID, slug: "demo", appOrigin: `https://demo--${"a".repeat(32)}.apps.example.com` })),
    createAppBuild: jest.fn(async (_id: string, req: any) => {
      calls.push("createBuild");
      return { buildId: "build-1", uploads: req.files.map((f: any) => ({ path: f.path, uploadUrl: `https://s3/${f.path}` })) };
    }),
    completeAppBuild: jest.fn(async () => {
      calls.push("complete");
      return {};
    }),
    publishAppEnvironment: jest.fn(async (_id: string, env: string) => {
      calls.push("publish");
      // shape of the backend's move(): { env: mapEnv(..), publishId, kind, buildId, previousBuildId, ... }
      return {
        env: { name: env, origin: `https://demo${env === "prod" ? "" : `--${env}`}--${"a".repeat(32)}.apps.example.com` },
        publishId: "pub-1",
        kind: "publish",
        buildId: "build-1",
        previousBuildId: null,
      };
    }),
    promoteAppEnvironment: jest.fn(async () => ({})),
    rollbackAppEnvironment: jest.fn(async () => ({})),
    listAppEnvironments: jest.fn(async () => [
      { name: "prod", vars: {}, dataMode: "separate", dataSourceEnv: "prod" },
      { name: "dev", vars: { A: "1" }, dataMode: "separate", dataSourceEnv: "prod" },
    ]),
    updateAppEnvironment: jest.fn(async () => ({})),
    listAppPublishes: jest.fn(async () => []),
    setAppSource: jest.fn(async () => ({ id: APP_ID, slug: "demo" })),
    startAppDevWorker: jest.fn(async () => ({ cloudWorkerId: "cw-1", created: true, started: true, status: "RUNNING", branch: "main" })),
    resolveGitRepository: jest.fn(async () => ({ id: REPO_ID })),
    ...over,
  };
  return { client: c as unknown as AppClient & typeof c, calls };
}

describe("hashBuildFiles", () => {
  it("hashes files recursively with sorted POSIX paths, hex sha256, size and content type", async () => {
    const dir = makeApp();
    const files = await hashBuildFiles(path.join(dir, "dist"));
    expect(files.map((f) => f.path)).toEqual(["assets/a.js", "index.html"]);
    expect(files[0]).toMatchObject({ sha256: sha("console.log(1)"), size: 14, contentType: "text/javascript" });
    expect(files[1]).toMatchObject({ sha256: sha("<html/>"), contentType: "text/html" });
  });

  it("fails clearly for a missing or empty output dir", async () => {
    await expect(hashBuildFiles(path.join(tmp("x-"), "nope"))).rejects.toThrow(/not found/);
    const empty = tmp("empty-");
    await expect(hashBuildFiles(empty)).rejects.toThrow(/empty/);
  });

  it("contentTypeFor falls back to octet-stream", () => {
    expect(contentTypeFor("a.wasm")).toBe("application/wasm");
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
  });
});

describe("publishApp", () => {
  it("builds, resolves, creates the build, uploads only the returned files, completes and publishes (default env prod)", async () => {
    const dir = makeApp();
    const { client, calls } = mockClient({
      createAppBuild: jest.fn(async (_id: string, req: any) => {
        calls.push("createBuild");
        // backend already has index.html: only a.js must be uploaded
        return { buildId: "build-1", uploads: [{ path: "assets/a.js", uploadUrl: "https://s3/a.js" }] };
      }),
    });
    const upload = jest.fn(async () => {});
    const runBuild = jest.fn(async () => {
      calls.push("build");
    });
    const r = await publishApp(client, { dir, runBuild, upload, push: false, note: "first" });

    expect(calls).toEqual(["build", "resolve", "createBuild", "complete", "publish"]);
    expect(runBuild).toHaveBeenCalledWith("npm run build", path.resolve(dir));
    expect(client.resolveApp).toHaveBeenCalledWith({ slug: "demo", name: "Demo" });
    const [id, req] = (client.createAppBuild as jest.Mock).mock.calls[0];
    expect(id).toBe(APP_ID);
    expect(req.files).toHaveLength(2);
    expect(req.files[0]).toEqual({ path: "assets/a.js", sha256: sha("console.log(1)"), size: 14, contentType: "text/javascript" });
    expect(req.manifest.slug).toBe("demo");
    expect(req).not.toHaveProperty("sourceCommit");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("https://s3/a.js", path.join(path.resolve(dir), "dist", "assets", "a.js"), "text/javascript");
    expect(client.publishAppEnvironment).toHaveBeenCalledWith(APP_ID, "prod", { buildId: "build-1", note: "first" });
    expect(r).toMatchObject({ env: "prod", buildId: "build-1", files: 2, uploaded: 1, skipped: 1 });
    expect(r.url).toBe(`https://demo--${"a".repeat(32)}.apps.example.com`);
  });

  it("skips every upload when the backend already has all files", async () => {
    const dir = makeApp();
    const { client } = mockClient({ createAppBuild: jest.fn(async () => ({ buildId: "b2", uploads: [] })) });
    const upload = jest.fn();
    const r = await publishApp(client, { dir, runBuild: jest.fn(), upload, push: false });
    expect(upload).not.toHaveBeenCalled();
    expect(client.completeAppBuild).toHaveBeenCalledWith(APP_ID, "b2");
    expect(r).toMatchObject({ uploaded: 0, skipped: 2 });
  });

  it("a build the backend reports as ready (nothing to upload) is not completed again", async () => {
    const dir = makeApp();
    const { client } = mockClient({
      createAppBuild: jest.fn(async () => ({ buildId: "b3", status: "ready", reused: 2, uploads: [], ready: true })),
    });
    await publishApp(client, { dir, runBuild: jest.fn(), upload: jest.fn(), push: false });
    expect(client.completeAppBuild).not.toHaveBeenCalled();
    expect(client.publishAppEnvironment).toHaveBeenCalledWith(APP_ID, "prod", { buildId: "b3" });
  });

  it("--env dev publishes to dev and uses the origin the backend returned", async () => {
    const dir = makeApp();
    const { client } = mockClient();
    const r = await publishApp(client, { dir, env: "dev", runBuild: jest.fn(), upload: jest.fn(), push: false });
    expect(client.publishAppEnvironment).toHaveBeenCalledWith(APP_ID, "dev", { buildId: "build-1" });
    expect(r.url).toBe(`https://demo--dev--${"a".repeat(32)}.apps.example.com`);
  });

  it("--no-build skips build.command", async () => {
    const dir = makeApp();
    const { client } = mockClient();
    const runBuild = jest.fn();
    await publishApp(client, { dir, build: false, runBuild, upload: jest.fn(), push: false });
    expect(runBuild).not.toHaveBeenCalled();
  });

  it("pushes the source BEFORE building/publishing and passes sourceCommit to the build and the publish", async () => {
    const dir = makeApp();
    const { client, calls } = mockClient();
    const pushSource = jest.fn(async () => {
      calls.push("push");
      return { sha: "a".repeat(40) };
    });
    await publishApp(client, { dir, pushSource, runBuild: jest.fn(async () => void calls.push("build")), upload: jest.fn() });
    expect(calls.slice(0, 3)).toEqual(["push", "build", "resolve"]);
    expect((client.createAppBuild as jest.Mock).mock.calls[0][1].sourceCommit).toBe("a".repeat(40));
    expect(client.publishAppEnvironment).toHaveBeenCalledWith(APP_ID, "prod", { buildId: "build-1", sourceCommit: "a".repeat(40) });
  });

  it("--no-push does not push", async () => {
    const dir = makeApp();
    const { client } = mockClient();
    const pushSource = jest.fn();
    await publishApp(client, { dir, push: false, pushSource, runBuild: jest.fn(), upload: jest.fn() });
    expect(pushSource).not.toHaveBeenCalled();
  });

  it("publishes without sourceCommit when there is no knowhow repository", async () => {
    const dir = makeApp();
    const { client } = mockClient();
    await publishApp(client, { dir, pushSource: async () => null, runBuild: jest.fn(), upload: jest.fn() });
    expect(client.publishAppEnvironment).toHaveBeenCalledWith(APP_ID, "prod", { buildId: "build-1" });
  });

  it("a failing push aborts before anything is built or created", async () => {
    const dir = makeApp();
    const { client } = mockClient();
    const runBuild = jest.fn();
    await expect(
      publishApp(client, {
        dir,
        pushSource: async () => {
          throw new Error("Publish aborted: conflicts");
        },
        runBuild,
        upload: jest.fn(),
      })
    ).rejects.toThrow(/conflicts/);
    expect(runBuild).not.toHaveBeenCalled();
    expect(client.resolveApp).not.toHaveBeenCalled();
  });

  it("uses build.outputDir from the manifest and fails without knowhow.app.json", async () => {
    const dir = makeApp({ build: { outputDir: "out" } }, {});
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "index.html"), "x");
    const { client } = mockClient();
    const r = await publishApp(client, { dir, upload: jest.fn(), push: false });
    expect(r.files).toBe(1);
    await expect(publishApp(client, { dir: tmp("nomanifest-"), push: false })).rejects.toThrow(/knowhow.app.json not found/);
  });

  it("rejects an upload the backend requests for an unknown file", async () => {
    const dir = makeApp();
    const { client } = mockClient({ createAppBuild: jest.fn(async () => ({ buildId: "b", uploads: [{ path: "evil", uploadUrl: "u" }] })) });
    await expect(publishApp(client, { dir, runBuild: jest.fn(), upload: jest.fn(), push: false })).rejects.toThrow(/unknown file/);
    expect(client.publishAppEnvironment).not.toHaveBeenCalled();
  });
});

describe("pushSourceIfKnowhowRepo (real git)", () => {
  const run = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

  it("returns null without a knowhow:// remote", async () => {
    const dir = tmp("nogit-");
    expect(await pushSourceIfKnowhowRepo({} as any, dir, () => {})).toBeNull();
    const repo = tmp("gitrepo-");
    run(repo, "init", "-q", "-b", "main");
    run(repo, "-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-q", "--allow-empty", "-m", "i");
    run(repo, "remote", "add", "origin", "https://github.com/acme/demo");
    expect(await pushSourceIfKnowhowRepo({} as any, repo, () => {})).toBeNull();
  });

  describe("with a knowhow:// remote", () => {
    function hostedRepo() {
      const repo = tmp("hosted-");
      run(repo, "init", "-q", "-b", "main");
      run(repo, "-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-q", "--allow-empty", "-m", "i");
      run(repo, "remote", "add", "knowhow", "knowhow://acme/demo");
      return repo;
    }
    afterEach(() => jest.restoreAllMocks());

    it("pushes via pushRepo and returns the pushed sha", async () => {
      const push = jest.spyOn(RepoSync, "pushRepo").mockResolvedValue({ branch: "main", status: "pushed", sha: "c".repeat(40), previousTip: null });
      const repo = hostedRepo();
      const r = await pushSourceIfKnowhowRepo({} as any, repo, () => {});
      expect(r).toMatchObject({ sha: "c".repeat(40), branch: "main" });
      expect(push).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ remote: "knowhow" }));
    });

    it("turns a conflict into a clear AppPushError", async () => {
      jest.spyOn(RepoSync, "pushRepo").mockRejectedValue(new RepoSync.RepoConflictError("diverged"));
      const err = await pushSourceIfKnowhowRepo({} as any, hostedRepo(), () => {}).catch((e) => e);
      expect(err).toBeInstanceOf(AppPushError);
      expect(err.message).toMatch(/conflicts with the Knowhow repository[\s\S]*diverged[\s\S]*--no-push/);
    });
  });
});

describe("app id resolution", () => {
  it("uses a uuid as is, else looks the slug up (--app or knowhow.app.json)", async () => {
    const { client } = mockClient();
    expect(await resolveAppId(client, { app: APP_ID })).toBe(APP_ID);
    expect(client.listApps).not.toHaveBeenCalled();
    expect(await resolveAppId(client, { app: "demo" })).toBe(APP_ID);
    expect(await resolveAppId(client, { dir: makeApp() })).toBe(APP_ID);
  });

  it("errors for unknown slugs and when nothing identifies the app", async () => {
    const { client } = mockClient();
    await expect(resolveAppId(client, { app: "nope" })).rejects.toThrow(/not found/);
    await expect(resolveAppId(client, { dir: tmp("none-") })).rejects.toThrow(/No app specified/);
  });
});

describe("environments", () => {
  it("parseEnvPairs keeps '=' in values and validates names", () => {
    expect(parseEnvPairs(["A=1", "URL=https://x?y=z", "E="])).toEqual({ A: "1", URL: "https://x?y=z", E: "" });
    expect(() => parseEnvPairs(["novalue"])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvPairs(["1BAD=x"])).toThrow(/Invalid variable name/);
    expect(() => parseEnvPairs([`${"A".repeat(65)}=x`])).toThrow(/max 64/);
  });

  it("env set merges into existing vars; unset removes and reports missing keys", async () => {
    const { client } = mockClient();
    expect(await setEnvVars(client, APP_ID, "dev", { B: "2" })).toEqual({ A: "1", B: "2" });
    // the backend PUT replaces `vars`, so the merged map is sent
    expect(client.updateAppEnvironment).toHaveBeenCalledWith(APP_ID, "dev", { vars: { A: "1", B: "2" } });
    const r = await unsetEnvVars(client, APP_ID, "dev", ["A", "ZZ"]);
    expect(r).toEqual({ vars: {}, missing: ["ZZ"] });
    expect(client.updateAppEnvironment).toHaveBeenLastCalledWith(APP_ID, "dev", { vars: {} });
  });

  it("env data sends dataMode and optional dataSourceEnv, validating flags", async () => {
    const { client } = mockClient();
    await setEnvDataMode(client, APP_ID, "dev", "shared", "prod");
    expect(client.updateAppEnvironment).toHaveBeenCalledWith(APP_ID, "dev", { dataMode: "shared", dataSourceEnv: "prod" });
    await setEnvDataMode(client, APP_ID, "dev", "shared");
    expect(client.updateAppEnvironment).toHaveBeenLastCalledWith(APP_ID, "dev", { dataMode: "shared" });
    await setEnvDataMode(client, APP_ID, "dev", "separate");
    expect(client.updateAppEnvironment).toHaveBeenLastCalledWith(APP_ID, "dev", { dataMode: "separate" });
    await expect(setEnvDataMode(client, APP_ID, "dev", "weird")).rejects.toThrow(/--mode/);
    await expect(setEnvDataMode(client, APP_ID, "dev", "shared", "dev")).rejects.toThrow(/different/);
    await expect(setEnvDataMode(client, APP_ID, "dev", "separate", "prod")).rejects.toThrow(/--source only applies/);
  });

  it("env data enforces the backend data-mode rules before calling it", async () => {
    const { client } = mockClient({
      listAppEnvironments: jest.fn(async () => [
        { name: "prod", dataMode: "separate", dataSourceEnv: "prod" },
        { name: "dev", dataMode: "separate", dataSourceEnv: "prod" },
        { name: "stg", dataMode: "shared", dataSourceEnv: "prod" },
        { name: "qa", dataMode: "separate", dataSourceEnv: "prod" },
      ]),
    });
    const before = (client.updateAppEnvironment as jest.Mock).mock.calls.length;
    await expect(setEnvDataMode(client, APP_ID, "prod", "shared", "dev")).rejects.toThrow(/prod always keeps its own data/);
    await expect(setEnvDataMode(client, APP_ID, "dev", "shared", "ghost")).rejects.toThrow(/does not exist/);
    await expect(setEnvDataMode(client, APP_ID, "dev", "shared", "stg")).rejects.toThrow(/itself shares data/);
    await expect(setEnvDataMode(client, APP_ID, "ghost", "shared", "prod")).rejects.toThrow(/Environment 'ghost' does not exist/);
    expect((client.updateAppEnvironment as jest.Mock).mock.calls.length).toBe(before);
    // separate never needs the source rules
    await setEnvDataMode(client, APP_ID, "stg", "separate");
    expect(client.updateAppEnvironment).toHaveBeenLastCalledWith(APP_ID, "stg", { dataMode: "separate" });
  });

  it("env set/unset fail clearly for an environment that does not exist", async () => {
    const { client } = mockClient();
    await expect(setEnvVars(client, APP_ID, "ghost", { A: "1" })).rejects.toThrow(/Environment 'ghost' does not exist/);
    expect(client.updateAppEnvironment).not.toHaveBeenCalled();
  });

  it("promote and rollback hit the right endpoints", async () => {
    const { client } = mockClient();
    await promoteApp(client, APP_ID, "dev", "prod");
    expect(client.promoteAppEnvironment).toHaveBeenCalledWith(APP_ID, "prod", { fromEnv: "dev" });
    await expect(promoteApp(client, APP_ID, "dev", "dev")).rejects.toThrow(/different/);
    await rollbackApp(client, APP_ID, "prod");
    expect(client.rollbackAppEnvironment).toHaveBeenCalledWith(APP_ID, "prod", {});
    await rollbackApp(client, APP_ID, "prod", "pub-9");
    expect(client.rollbackAppEnvironment).toHaveBeenLastCalledWith(APP_ID, "prod", { publishId: "pub-9" });
  });

  it("status joins environments with their latest publish; history is newest first", async () => {
    const publishes = [
      { id: "p1", envName: "prod", kind: "publish", createdAt: "2026-01-01T00:00:00Z" },
      { id: "p2", envName: "prod", kind: "rollback", createdAt: "2026-01-03T00:00:00Z" },
      { id: "p3", envName: "dev", kind: "publish", createdAt: "2026-01-02T00:00:00Z" },
    ];
    const { client } = mockClient({
      listAppEnvironments: jest.fn(async () => [{ name: "prod", buildId: "b1" }, { name: "dev", buildId: "b2" }]),
      listAppPublishes: jest.fn(async () => publishes),
    });
    const s = await appStatus(client, APP_ID);
    expect(s.environments.map((e) => [e.name, e.lastPublish?.id])).toEqual([["prod", "p2"], ["dev", "p3"]]);
    expect(s.environments[1].url).toContain("--dev--"); // derived: these records carry no origin
    expect((await appHistory(client, APP_ID, "prod")).map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(client.listAppPublishes).toHaveBeenLastCalledWith(APP_ID, "prod");
  });
});

describe("envUrl", () => {
  const app = { id: APP_ID, slug: "demo", appOrigin: `http://demo--${"b".repeat(32)}.apps.localhost:4000` };
  it("prod = appOrigin, other env inserts --env before the app id, backend url wins", () => {
    expect(envUrl(app, "prod")).toBe(app.appOrigin);
    expect(envUrl(app, "dev")).toBe(`http://demo--dev--${"b".repeat(32)}.apps.localhost:4000`);
    expect(envUrl(app, "dev", { url: "https://x" })).toBe("https://x");
    expect(envUrl({ id: "1", slug: "s" }, "dev")).toBeUndefined();
  });

  it("prefers what the backend returns: env.origin (publish/promote/rollback), origin (env record), app.appOrigin for the requested env", () => {
    expect(envUrl(app, "dev", { env: { origin: "https://pub" }, origin: "https://rec" })).toBe("https://pub");
    expect(envUrl(app, "dev", { origin: "https://rec" })).toBe("https://rec");
    expect(envUrl({ ...app, envName: "dev", appOrigin: "https://from-getapp" }, "dev")).toBe("https://from-getapp");
    // an appOrigin that describes another (non-prod) env is never used to derive this one
    expect(envUrl({ ...app, envName: "dev" }, "prod", {})).toBeUndefined();
    expect(envUrl({ ...app, envName: "prod" }, "dev", {})).toBe(`http://demo--dev--${"b".repeat(32)}.apps.localhost:4000`);
  });
});

describe("app source / develop", () => {
  const run = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  /** git repo with a knowhow:// remote on `feature`, containing an app dir `apps/demo` */
  function hostedRepoWithApp() {
    const repo = fs.realpathSync(tmp("src-repo-"));
    run(repo, "init", "-q", "-b", "feature");
    fs.mkdirSync(path.join(repo, "apps", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "demo", "knowhow.app.json"), "{}");
    run(repo, "add", ".");
    run(repo, "-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-q", "-m", "i");
    run(repo, "remote", "add", "knowhow", "knowhow://acme/demo");
    return repo;
  }

  it("resolves the git repo's Knowhow repository, current branch and the app dir relative to the git root", async () => {
    const repo = hostedRepoWithApp();
    const { client } = mockClient();
    const link = await linkAppSource(client, APP_ID, path.join(repo, "apps", "demo"));
    expect(client.resolveGitRepository).toHaveBeenCalledWith(expect.objectContaining({ originUrl: expect.stringContaining("knowhow://") }));
    expect(link).toEqual({ repositoryId: REPO_ID, branch: "feature", subdir: "apps/demo" });
    expect(client.setAppSource).toHaveBeenCalledWith(APP_ID, { repositoryId: REPO_ID, branch: "feature", subdir: "apps/demo" });
  });

  it("omits subdir at the git root", async () => {
    const repo = hostedRepoWithApp();
    const { client } = mockClient();
    await linkAppSource(client, APP_ID, repo);
    expect(client.setAppSource).toHaveBeenCalledWith(APP_ID, { repositoryId: REPO_ID, branch: "feature" });
  });

  it("--repo/--branch/--subdir override and skip repository resolution", async () => {
    const { client } = mockClient();
    await setAppSource(client, APP_ID, tmp("nogit-"), { repo: "r-1", branch: "dev", subdir: "/x/y/" });
    expect(client.resolveGitRepository).not.toHaveBeenCalled();
    expect(client.setAppSource).toHaveBeenCalledWith(APP_ID, { repositoryId: "r-1", branch: "dev", subdir: "x/y" });
  });

  it("--clear sends repositoryId null and rejects combination with other flags", async () => {
    const { client } = mockClient();
    await setAppSource(client, APP_ID, ".", { clear: true });
    expect(client.setAppSource).toHaveBeenCalledWith(APP_ID, { repositoryId: null });
    await expect(setAppSource(client, APP_ID, ".", { clear: true, repo: "r" })).rejects.toThrow(/--clear/);
  });

  it("fails clearly outside a git repository", async () => {
    const { client } = mockClient();
    await expect(setAppSource(client, APP_ID, tmp("nogit-"), {})).rejects.toThrow(/git repository/);
    expect(client.setAppSource).not.toHaveBeenCalled();
  });

  describe("publish links the source automatically", () => {
    const pushSource = async () => ({ sha: "a".repeat(40) });

    it("after a successful push, when the app has no source yet", async () => {
      const dir = makeApp();
      const { client } = mockClient();
      const linkSource = jest.fn(async () => ({ repositoryId: REPO_ID, branch: "main", subdir: "apps/demo" }));
      const log = jest.fn();
      const r = await publishApp(client, { dir, pushSource, linkSource, runBuild: jest.fn(), upload: jest.fn(), log });
      expect(linkSource).toHaveBeenCalledWith(client, APP_ID, path.resolve(dir));
      expect(r.sourceLinked).toEqual({ repositoryId: REPO_ID, branch: "main", subdir: "apps/demo" });
      expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/linked repository 99999999 @ main \(apps\/demo\/\)/);
    });

    it("never overwrites an existing source", async () => {
      const dir = makeApp();
      const { client } = mockClient({
        resolveApp: jest.fn(async () => ({ id: APP_ID, slug: "demo", sourceRepositoryId: "other-repo" })),
      });
      const linkSource = jest.fn();
      const r = await publishApp(client, { dir, pushSource, linkSource, runBuild: jest.fn(), upload: jest.fn() });
      expect(linkSource).not.toHaveBeenCalled();
      expect(r.sourceLinked).toBeUndefined();
    });

    it("does not link without a pushed source (no repo / --no-push)", async () => {
      const dir = makeApp();
      const { client } = mockClient();
      const linkSource = jest.fn();
      await publishApp(client, { dir, pushSource: async () => null, linkSource, runBuild: jest.fn(), upload: jest.fn() });
      await publishApp(client, { dir, push: false, linkSource, runBuild: jest.fn(), upload: jest.fn() });
      expect(linkSource).not.toHaveBeenCalled();
    });

    it("a failing link only warns: the publish still succeeds", async () => {
      const dir = makeApp();
      const { client } = mockClient();
      const log = jest.fn();
      const r = await publishApp(client, {
        dir,
        pushSource,
        linkSource: async () => {
          throw new Error("boom");
        },
        runBuild: jest.fn(),
        upload: jest.fn(),
        log,
      });
      expect(r.buildId).toBe("build-1");
      expect(r.sourceLinked).toBeUndefined();
      expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/could not link the source repository.*boom/);
    });
  });

  describe("develop", () => {
    it("starts the dev worker (with --env) and builds the chat URL from the frontend url", async () => {
      const { client } = mockClient();
      const r = await developApp(client, APP_ID, { env: "dev", frontendUrl: "https://knowhow.example.com/" });
      expect(client.startAppDevWorker).toHaveBeenCalledWith(APP_ID, { env: "dev" });
      expect(r.worker.cloudWorkerId).toBe("cw-1");
      expect(r.path).toBe("/dashboard/workers/chat?workerId=cw-1");
      expect(r.url).toBe("https://knowhow.example.com/dashboard/workers/chat?workerId=cw-1");
    });

    it("sends no env by default and derives the frontend from the API url; unknown frontend -> path only", async () => {
      const { client } = mockClient();
      expect((await developApp(client, APP_ID, { apiUrl: "https://api.knowhow.tyvm.ai", frontendUrl: undefined })).url).toMatch(
        /^https:\/\/knowhow\.tyvm\.ai\/dashboard\/workers\/chat\?workerId=cw-1$/
      );
      expect(client.startAppDevWorker).toHaveBeenCalledWith(APP_ID, {});
      const none = await developApp(client, APP_ID, { apiUrl: "https://backend.internal.example" });
      expect(none.url).toBeUndefined();
      expect(none.path).toContain("workerId=cw-1");
    });

    it("frontendBaseUrl: env override, localhost -> :3000, api. prefix stripped", () => {
      expect(frontendBaseUrl("https://api.x.com", "https://override/")).toBe("https://override");
      expect(frontendBaseUrl("http://localhost:4000", undefined)).toBe("http://localhost:3000");
      expect(frontendBaseUrl("https://api.dev.knowhow.tyvm.ai", undefined)).toBe("https://dev.knowhow.tyvm.ai");
      expect(frontendBaseUrl(undefined, undefined)).toBeUndefined();
    });
  });
});
