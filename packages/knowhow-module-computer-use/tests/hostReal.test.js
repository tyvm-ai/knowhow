// Optional end-to-end test against the real release host binary (skipped if not built).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { hostBinaryPath } = require("../ts_build/host/hostLauncher");
const hostOps = require("../ts_build/host/hostOps");
const { probeHost } = require("../ts_build/host/hostLauncher");

const bin = hostBinaryPath();
const d = bin && process.platform !== "win32" ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};

d("real host binary", () => {
  let home, proj, child;
  const prev = { HOME: process.env.HOME, cwd: process.cwd(), ENDPOINT: process.env.KNOWHOW_HOST_ENDPOINT };

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join("/tmp", "khreal-"));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "khrealproj-"));
    fs.mkdirSync(path.join(proj, ".knowhow", "automations"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".knowhow", "automations", "keepalive.ts"),
      "/** @automation\n * singleInstance: replace\n */\nsdk.keepAlive();\n"
    );
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.KNOWHOW_HOST_ENDPOINT;
    process.chdir(proj);
    child = spawn(bin, ["--no-tray", "--foreground"], { env: { ...process.env, HOME: home }, stdio: "ignore" });
    expect(await until(() => probeHost())).toBe(true);
  });

  afterAll(async () => {
    try { await hostOps.hostRequest({ type: "shutdown" }); } catch {}
    await sleep(200);
    try { child.kill("SIGKILL"); } catch {}
    process.chdir(prev.cwd);
    process.env.HOME = prev.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });

  test("start a worker via the real worker.js, see it in ps, stop --all", async () => {
    const res = await hostOps.startAutomation("keepalive", { maxMs: 60000 });
    expect(res.started).toBe(true);
    expect(await until(async () => (await hostOps.listWorkers()).some((w) => w.name === "keepalive" && w.connected))).toBe(true);
    const [w] = await hostOps.listWorkers();
    expect(w.status).toBe("running");
    const stopped = await hostOps.stopAutomations({ all: true });
    expect(stopped.stopped).toContain(w.id);
    expect(await until(async () => (await hostOps.listWorkers()).every((x) => x.status === "exited"))).toBe(true);
  }, 30000);
});
