import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { execFileSync } from "child_process";
import {
  WorkingSetSyncer,
  backoffMs,
  decideSync,
  minGapMs,
  readWorkingSetState,
  resolveWorkingSetSyncConfig,
  workingSetChanged,
  writeWorkingSetState,
  WORKING_SET_DEFAULT_MAX_BYTES,
} from "../../../src/services/WorkingSetSync";
import { TransportClient } from "../../../src/services/TaskTransport";

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

const cfg = (o: Parameters<typeof resolveWorkingSetSyncConfig>[0] = {}) =>
  resolveWorkingSetSyncConfig(o, {}, undefined);

describe("resolveWorkingSetSyncConfig", () => {
  it("defaults: enabled, 60s, large-bundle 5min, 200MB", () => {
    const c = cfg();
    expect(c.enabled).toBe(true);
    expect(c.intervalMs).toBe(60_000);
    expect(c.largeIntervalMs).toBe(300_000);
    expect(c.maxBytes).toBe(WORKING_SET_DEFAULT_MAX_BYTES);
  });

  it("honours config enabled:false / intervalSeconds / maxBytes", () => {
    const c = cfg({ enabled: false, intervalSeconds: 10, maxBytes: 1234 });
    expect(c.enabled).toBe(false);
    expect(c.intervalMs).toBe(10_000);
    expect(c.maxBytes).toBe(1234);
    // large interval never drops below the normal interval
    expect(cfg({ intervalSeconds: 900 }).largeIntervalMs).toBe(900_000);
  });

  it("env KNOWHOW_WORKING_SET_SYNC overrides config; runtime toggle overrides env", () => {
    expect(resolveWorkingSetSyncConfig({}, { KNOWHOW_WORKING_SET_SYNC: "0" }, undefined).enabled).toBe(false);
    expect(resolveWorkingSetSyncConfig({}, { KNOWHOW_WORKING_SET_SYNC: "off" }, undefined).enabled).toBe(false);
    expect(
      resolveWorkingSetSyncConfig({ enabled: false }, { KNOWHOW_WORKING_SET_SYNC: "1" }, undefined).enabled
    ).toBe(true);
    expect(resolveWorkingSetSyncConfig({}, { KNOWHOW_WORKING_SET_SYNC: "0" }, true).enabled).toBe(true);
    expect(resolveWorkingSetSyncConfig({}, {}, false).enabled).toBe(false);
    expect(
      resolveWorkingSetSyncConfig({ intervalSeconds: 10 }, { KNOWHOW_WORKING_SET_SYNC_INTERVAL: "5" }, undefined)
        .intervalMs
    ).toBe(5000);
  });
});

describe("decideSync (debounce / throttle)", () => {
  const c = cfg();

  it("runs immediately when nothing was ever checked", () => {
    expect(decideSync({ now: 1_000_000, state: {}, cfg: c })).toEqual({ action: "run" });
  });

  it("waits out the remainder of the interval since the last check", () => {
    const d = decideSync({ now: 1_030_000, state: { checkedAt: 1_000_000 }, cfg: c });
    expect(d).toEqual({ action: "wait", waitMs: 30_000 });
    expect(decideSync({ now: 1_060_000, state: { checkedAt: 1_000_000 }, cfg: c })).toEqual({ action: "run" });
  });

  it("uses the later of pushedAt / checkedAt", () => {
    const d = decideSync({ now: 1_010_000, state: { checkedAt: 900_000, pushedAt: 1_000_000 }, cfg: c });
    expect(d).toEqual({ action: "wait", waitMs: 50_000 });
  });

  it("backs off to the large interval after a big bundle", () => {
    const big = { checkedAt: 1_000_000, sizeBytes: 50 * 1024 * 1024 };
    expect(minGapMs(c, big.sizeBytes)).toBe(300_000);
    expect(decideSync({ now: 1_100_000, state: big, cfg: c })).toEqual({ action: "wait", waitMs: 200_000 });
    expect(minGapMs(c, 1024)).toBe(60_000);
  });

  it("force (task completion) always runs; failure backoff delays non-forced runs", () => {
    expect(decideSync({ now: 1_000_001, state: { checkedAt: 1_000_000 }, cfg: c, force: true })).toEqual({
      action: "run",
    });
    expect(
      decideSync({ now: 1_100_000, state: { checkedAt: 1_000_000 }, cfg: c, backoffUntil: 1_150_000 })
    ).toEqual({ action: "wait", waitMs: 50_000 });
  });

  it("backoffMs doubles and is capped at 10 minutes", () => {
    expect(backoffMs(60_000, 0)).toBe(0);
    expect(backoffMs(60_000, 1)).toBe(60_000);
    expect(backoffMs(60_000, 3)).toBe(240_000);
    expect(backoffMs(60_000, 10)).toBe(600_000);
  });
});

describe("workingSetChanged (tree hash)", () => {
  it("is false only when both the tree and HEAD match the last push", () => {
    const st = { treeHash: "t1", headSha: "h1" };
    expect(workingSetChanged(st, "t1", "h1")).toBe(false);
    expect(workingSetChanged(st, "t2", "h1")).toBe(true);
    expect(workingSetChanged(st, "t1", "h2")).toBe(true);
    expect(workingSetChanged({}, "t1", "h1")).toBe(true);
  });
});

describe("state persistence", () => {
  it("round-trips through the task dir and tolerates a missing file", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ws-state-"));
    try {
      expect(readWorkingSetState("t", base)).toEqual({});
      writeWorkingSetState("t", { treeHash: "abc", snapshotId: "s1", pushedAt: 5 }, base);
      expect(readWorkingSetState("t", base)).toEqual({ treeHash: "abc", snapshotId: "s1", pushedAt: 5 });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("WorkingSetSyncer (real git repo, mock client)", () => {
  let tmp: string;
  let repo: string;
  let agentsDir: string;
  let server: http.Server;
  let port: number;
  let uploads: string[];
  const run = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-syncer-"));
    repo = path.join(tmp, "repo");
    agentsDir = path.join(tmp, "agents");
    fs.mkdirSync(repo, { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "alpha\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "init");
    run(repo, "remote", "add", "origin", "git@github.com:Org/Repo.git");
    uploads = [];
    server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        uploads.push(req.url || "");
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

  function mockClient() {
    const calls: Record<string, any[]> = {};
    const rec = (n: string, v: any) => (calls[n] ||= []).push(v);
    const client: TransportClient = {
      resolveGitRepository: async (req) => {
        rec("resolve", req);
        return { id: "repo1", bundles: [] };
      },
      createGitRepositoryBundle: async (_repoId, req) => {
        rec("bundle", req);
        return { bundleId: `b${calls.bundle.length}`, uploadUrl: `http://127.0.0.1:${port}/b${calls.bundle.length}` };
      },
      completeGitRepositoryBundle: async (_r, id) => rec("complete", id),
      upsertTaskWorkspace: async (t, req) => rec("workspace", { t, req }),
      createTaskWorkspaceSnapshot: async (t, req) => {
        rec("snapshot", { t, req });
        return { id: `s${calls.snapshot.length}`, seq: calls.snapshot.length };
      },
      createTaskOffload: async () => ({ id: "o1", state: "requested" }),
      getTaskOffload: async () => ({ id: "o1", state: "running", log: [] }),
      getTaskWorkspace: async () => ({}),
    };
    return { client, calls };
  }

  function makeSyncer(client: TransportClient, remote: string | null = "remote-1") {
    return new WorkingSetSyncer({
      client,
      localTaskId: "local-1",
      remoteTaskId: () => remote ?? undefined,
      cwd: repo,
      baseDir: agentsDir,
      getConfig: () => ({ enabled: true }),
    });
  }

  it("pushes a changed tree once (with hostname + fileCount), skips an unchanged tree, pushes again after an edit", async () => {
    const { client, calls } = mockClient();
    const syncer = makeSyncer(client);
    fs.writeFileSync(path.join(repo, "a.txt"), "alpha changed\n");
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=SUPERSECRET\n");

    expect(await syncer.flush()).toBe("pushed");
    expect(calls.snapshot).toHaveLength(1);
    const manifest = calls.snapshot[0].req.manifest;
    expect(manifest.hostname).toBe(os.hostname());
    expect(manifest.fileCount).toBe(1);
    expect(manifest.excluded.join("\n")).toContain(".env");
    expect(calls.snapshot[0].t).toBe("remote-1");
    const st = readWorkingSetState("local-1", agentsDir);
    expect(st.treeHash).toBeTruthy();
    expect(st.snapshotId).toBe("s1");

    // no change -> nothing uploaded, no new API calls
    const bundlesBefore = calls.bundle.length;
    expect(await syncer.flush()).toBe("unchanged");
    expect(calls.bundle).toHaveLength(bundlesBefore);
    expect(calls.snapshot).toHaveLength(1);

    // a fresh syncer (process restart) reads the persisted tree hash and also skips
    expect(await makeSyncer(client).flush()).toBe("unchanged");

    // an edit -> pushed again, base bundle not re-uploaded (same HEAD)
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
    expect(await syncer.flush()).toBe("pushed");
    expect(calls.snapshot).toHaveLength(2);
    expect(calls.bundle.filter((b) => b.kind === "base")).toHaveLength(1);
    expect(readWorkingSetState("local-1", agentsDir).snapshotId).toBe("s2");
  });

  it("does nothing when the task is not linked to a remote task, or cwd is not a git repo", async () => {
    const { client, calls } = mockClient();
    expect(await makeSyncer(client, null).flush()).toBe("not-linked");
    const s = new WorkingSetSyncer({
      client,
      localTaskId: "x",
      remoteTaskId: () => "r",
      cwd: tmp,
      baseDir: agentsDir,
      getConfig: () => ({ enabled: true }),
    });
    expect(await s.flush()).toBe("no-repo");
    expect(calls.snapshot).toBeUndefined();
  });

  it("is disabled by config and never touches the client", async () => {
    const { client, calls } = mockClient();
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const s = new WorkingSetSyncer({
      client,
      localTaskId: "local-1",
      remoteTaskId: () => "r",
      cwd: repo,
      baseDir: agentsDir,
      getConfig: () => ({ enabled: false }),
    });
    expect(await s.flush()).toBe("disabled");
    s.notify();
    expect(calls.resolve).toBeUndefined();
  });

  it("skips (and remembers) a working set larger than maxBytes", async () => {
    const { client, calls } = mockClient();
    fs.writeFileSync(path.join(repo, "a.txt"), "x".repeat(5000) + Math.random());
    const s = new WorkingSetSyncer({
      client,
      localTaskId: "local-1",
      remoteTaskId: () => "r",
      cwd: repo,
      baseDir: agentsDir,
      getConfig: () => ({ enabled: true, maxBytes: 100 }),
    });
    expect(await s.flush()).toBe("too-large");
    expect(calls.snapshot).toBeUndefined();
    expect(await s.flush()).toBe("too-large");
  });

  it("swallows client errors (returns error, never throws) and backs off", async () => {
    const { client } = mockClient();
    client.resolveGitRepository = async () => {
      throw new Error("boom");
    };
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const warn = jest.fn();
    const s = new WorkingSetSyncer({
      client,
      localTaskId: "local-1",
      remoteTaskId: () => "r",
      cwd: repo,
      baseDir: agentsDir,
      getConfig: () => ({ enabled: true }),
      log: { info: jest.fn(), warn },
    });
    await expect(s.flush()).resolves.toBe("error");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("is single-flight: a second run while one is in progress reports busy", async () => {
    const { client } = mockClient();
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const s = makeSyncer(client);
    const first = s.run(true);
    const second = await s.run(true);
    expect(second).toBe("busy");
    expect(await first).toBe("pushed");
  });
});
