// Host local-connection hardening, client side: control/worker tokens, structured start,
// approval/re-arm requests, owner-only store files. (Host-side enforcement is covered by
// the Rust suites; hostReal.test.js runs the real binary end to end.)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startFakeHost } = require("./hostFake");
const { HostClient, hostTokenPath, readHostToken } = require("../ts_build/host/HostClient");
const hostOps = require("../ts_build/host/hostOps");
const { runnerArgs } = require("../ts_build/host/hostLauncher");
const { runWorker } = require("../ts_build/host/worker");
const { createStore } = require("../ts_build/store");

const unix = process.platform === "win32" ? describe.skip : describe;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

unix("host auth (fake host)", () => {
  let dir, home, host, proj;
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ENDPOINT: process.env.KNOWHOW_HOST_ENDPOINT,
    WT: process.env.KNOWHOW_CU_WORKER_TOKEN,
    cwd: process.cwd(),
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join("/tmp", "khauth-"));
    home = fs.mkdtempSync(path.join("/tmp", "khauthhome-"));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "khauthproj-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.KNOWHOW_CU_WORKER_TOKEN;
    host = await startFakeHost(dir);
    process.env.KNOWHOW_HOST_ENDPOINT = host.sock;
  });
  afterEach(async () => {
    process.chdir(prev.cwd);
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.ENDPOINT === undefined) delete process.env.KNOWHOW_HOST_ENDPOINT;
    else process.env.KNOWHOW_HOST_ENDPOINT = prev.ENDPOINT;
    if (prev.WT === undefined) delete process.env.KNOWHOW_CU_WORKER_TOKEN;
    else process.env.KNOWHOW_CU_WORKER_TOKEN = prev.WT;
    await host.close();
    for (const d of [dir, home, proj]) fs.rmSync(d, { recursive: true, force: true });
  });

  const writeToken = (t) => {
    fs.mkdirSync(path.dirname(hostTokenPath()), { recursive: true });
    fs.writeFileSync(hostTokenPath(), t + "\n", { mode: 0o600 });
  };

  test("control clients present ~/.knowhow/computer-use/host.token in their hello", async () => {
    host.tokens.control = "s3cret";
    writeToken("s3cret");
    expect(hostTokenPath()).toBe(path.join(home, ".knowhow", "computer-use", "host.token"));
    expect(readHostToken()).toBe("s3cret");
    const c = await HostClient.connect("control", { endpoint: host.sock });
    expect(host.ofType("hello")[0]).toMatchObject({ role: "control", token: "s3cret" });
    c.close();
  });

  test("control hello is refused with a stale, wrong or missing token", async () => {
    host.tokens.control = "fresh";
    writeToken("stale"); // e.g. the token of a previous host run
    await expect(HostClient.connect("control", { endpoint: host.sock })).rejects.toThrow(/unauthorized/);
    fs.rmSync(hostTokenPath());
    expect(readHostToken()).toBe("");
    await expect(HostClient.connect("control", { endpoint: host.sock })).rejects.toThrow(/unauthorized/);
    await expect(HostClient.connect("control", { endpoint: host.sock, token: "nope" })).rejects.toThrow(/unauthorized/);
    const ok = await HostClient.connect("control", { endpoint: host.sock, token: "fresh" });
    ok.close();
  });

  test("workers present KNOWHOW_CU_WORKER_TOKEN; the control token is not accepted for them", async () => {
    host.tokens.worker = "w-secret";
    host.tokens.control = "c-secret";
    process.env.KNOWHOW_CU_WORKER_TOKEN = "w-secret";
    const w = await HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "n" });
    expect(host.ofType("hello")[0]).toMatchObject({ role: "worker", workerId: "w1", token: "w-secret" });
    w.close();
    await expect(
      HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "n", token: "c-secret" })
    ).rejects.toThrow(/unauthorized/);
    delete process.env.KNOWHOW_CU_WORKER_TOKEN;
    await expect(HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "n" })).rejects.toThrow(
      /unauthorized/
    );
  });

  test("runWorker forwards its env token (and exits 1 when the host refuses it)", async () => {
    host.tokens.worker = "w-secret";
    fs.mkdirSync(path.join(proj, ".knowhow", "automations"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".knowhow", "automations", "demo.ts"), "sdk.keepAlive();");
    const baseEnv = { KNOWHOW_HOST_WORKER_ID: "wid", KNOWHOW_HOST_NAME: "demo", KNOWHOW_HOST_ENDPOINT: host.sock };
    const svc = () => ({ async getActiveWindow() { return { title: "x", app: "x" }; }, async keyDown() {}, async keyUp() {} });
    // wrong token: the hello fails -> runWorker rejects/exits non-zero, no automation runs
    await expect(runWorker({ name: "demo", cwd: proj }, { ...baseEnv, KNOWHOW_CU_WORKER_TOKEN: "bad" }, svc)).rejects.toThrow(
      /unauthorized/
    );
    const code = runWorker({ name: "demo", cwd: proj }, { ...baseEnv, KNOWHOW_CU_WORKER_TOKEN: "w-secret" }, svc);
    for (let i = 0; i < 100 && host.ofType("hello").filter((m) => m.token === "w-secret").length === 0; i++) await sleep(20);
    expect(host.ofType("hello").some((m) => m.token === "w-secret")).toBe(true);
    await sleep(100);
    host.push({ type: "stop" });
    expect(await code).toBe(0);
  });

  test("startAutomation sends {automationPath, args} only: never an argv or env", async () => {
    host.handlers.start = (m) => ({ ok: true, result: { started: true, worker: { id: "x", pid: 1, name: m.name, logPath: "/l" } } });
    fs.mkdirSync(path.join(proj, ".knowhow", "automations"), { recursive: true });
    const file = path.join(proj, ".knowhow", "automations", "farm.ts");
    fs.writeFileSync(file, "/** @automation\n * singleInstance: ignore\n */\nsdk.keepAlive();");
    process.chdir(proj);
    const res = await hostOps.startAutomation("farm", { maxMs: 5000, params: '{"a":1}', dryRun: true });
    expect(res.started).toBe(true);
    const [msg] = host.ofType("start");
    expect(msg.type).toBe("start");
    expect(fs.realpathSync(msg.automationPath)).toBe(fs.realpathSync(file));
    expect(path.isAbsolute(msg.automationPath)).toBe(true);
    expect(msg.name).toBe("farm");
    expect(msg.singleInstance).toBe("ignore");
    expect(msg.args).toEqual({ params: { a: 1 }, maxDurationMs: 5000, dryRun: true });
    expect(msg).not.toHaveProperty("argv");
    expect(msg).not.toHaveProperty("env");
    // the control hello carried the token file (empty here: no host.token written)
    expect(host.ofType("hello").every((m) => "token" in m)).toBe(true);
  });

  test("runner args are fixed by the launcher (node + worker.js), not by callers", () => {
    const a = runnerArgs();
    expect(a[0]).toBe("--node");
    expect(a[1]).toBe(process.execPath);
    expect(a[2]).toBe("--runner");
    expect(path.basename(a[3])).toBe("worker.js");
  });

  test("approve / approvals / revoke / rearm map to host requests", async () => {
    fs.mkdirSync(path.join(proj, ".knowhow", "automations"), { recursive: true });
    const file = path.join(proj, ".knowhow", "automations", "a.ts");
    fs.writeFileSync(file, "x");
    process.chdir(proj);
    host.handlers.approve = (m) => ({ ok: true, result: { approved: true, path: m.automationPath, kind: "always" } });
    host.handlers.approvals = () => ({ ok: true, result: { approvals: [{ path: "/p", approvedAt: 1, lastRunAt: 2 }] } });
    host.handlers.audit = (m) => ({
      ok: true,
      result: { entries: [{ ts: 1, event: "start", path: "/p", kind: "always", workerId: "w1", pid: 7, sha256: "ab".repeat(32) }].slice(-m.limit) },
    });
    host.handlers.revoke = (m) => ({ ok: true, result: { revoked: m.all ? ["/p"] : [m.automationPath] } });
    host.handlers.rearm = () => ({ ok: true, result: { rearmed: false, halted: true } });
    const r = await hostOps.approveAutomation("a");
    expect(fs.realpathSync(r.path)).toBe(fs.realpathSync(file));
    expect((await hostOps.listApprovals())[0]).toEqual({ path: "/p", approvedAt: 1, lastRunAt: 2 });
    const audit = await hostOps.auditLog(10);
    expect(audit[0].event).toBe("start");
    const line = hostOps.formatAuditEntry(audit[0]);
    expect(line).toContain("start");
    expect(line).toContain("[always]");
    expect(line).toContain("/p");
    expect(line).toContain("worker=w1/pid 7");
    expect((await hostOps.revokeApproval({ all: true })).revoked).toEqual(["/p"]);
    // a deleted script can still be revoked by its literal path
    expect((await hostOps.revokeApproval({ nameOrPath: "/gone/x.ts" })).revoked).toEqual(["/gone/x.ts"]);
    expect(await hostOps.rearmKillSwitch()).toEqual({ rearmed: false, halted: true });
  });
});

unix("owner-only files", () => {
  test("sdk.store files are 0600 and their directory 0700", async () => {
    const home = fs.mkdtempSync(path.join("/tmp", "khstore-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const store = createStore("modes", "state", { n: 0 });
      await store.set({ n: 1 });
      const file = path.join(home, ".knowhow", "automations-data", "modes", "state.json");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      // a pre-existing loose file is tightened on the next write
      fs.chmodSync(file, 0o644);
      await store.update((s) => ({ n: s.n + 1 }));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ n: 2 });
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
