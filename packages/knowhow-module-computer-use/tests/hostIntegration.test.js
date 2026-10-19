const fs = require("fs");
const os = require("os");
const path = require("path");
const { startFakeHost } = require("./hostFake");
const { HostClient } = require("../ts_build/host/HostClient");
const { HostHotkeyProvider } = require("../ts_build/host/HostHotkeyProvider");
const { parseSingleInstance } = require("../ts_build/host/hostLauncher");
const { runWorker } = require("../ts_build/host/worker");
const { AutomationRunner, setKillSwitchArmed } = require("../ts_build/automation");
const { setHotkeyProvider } = require("../ts_build/hotkeys");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
};
const d = process.platform === "win32" ? describe.skip : describe;

d("host integration (fake host)", () => {
  let dir, host;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join("/tmp", "khfake-"));
    host = await startFakeHost(dir);
  });
  afterEach(async () => {
    setKillSwitchArmed(false);
    setHotkeyProvider(null);
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const svc = () => ({
    async getActiveWindow() { return { title: "x", app: "x" }; },
    async keyDown() {},
    async keyUp() {},
  });

  test("HostClient correlates requests and surfaces errors", async () => {
    const c = await HostClient.connect("control", { endpoint: host.sock });
    expect(c.helloResult.killSwitchArmed).toBe(true);
    const [a, b] = await Promise.all([c.request({ type: "status" }), c.request({ type: "list" })]);
    expect(a.pid).toBe(1);
    expect(b.workers).toEqual([]);
    c.close();
    const w = await HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "n" });
    await expect(
      w.request({ type: "registerHotkey", id: "k", chord: "ctrl+alt+escape" })
    ).rejects.toThrow(/kill switch/);
    w.close();
  });

  test("HostClient request rejects on timeout", async () => {
    const c = await HostClient.connect("control", { endpoint: host.sock });
    await expect(c.request({ type: "silent" }, 50)).rejects.toThrow(/timed out/);
    c.close();
  });

  test("provider: register -> hotkey event -> handler -> hotkeyDone; heldKeys; stop ends run", async () => {
    const client = await HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "t" });
    const provider = new HostHotkeyProvider(client);
    const runner = new AutomationRunner(
      {
        name: "hk",
        script: `
          sdk.hotkeys.on("ctrl+shift+k", async () => { sdk.log("fired"); await sdk.keyDown("shift"); await sdk.sleep(30); }, { concurrency: "drop", noRepeat: true });
        `,
      },
      svc(),
      {
        maxDurationMs: 5000,
        hotkeyProvider: provider,
        onHeldKeysChange: provider.heldKeysReporter(),
        tray: provider.trayBridge(),
      }
    );
    provider.bindRunner(runner);
    const run = runner.run();
    expect(await until(() => host.ofType("registerHotkey").length === 1)).toBe(true);
    const reg = host.ofType("registerHotkey")[0];
    expect(reg).toMatchObject({ chord: "ctrl+shift+k", concurrency: "drop", noRepeat: true, consume: true });

    host.push({ type: "hotkey", id: reg.id });
    expect(await until(() => host.ofType("hotkeyDone").length === 1)).toBe(true);
    expect(host.ofType("hotkeyDone")[0].id).toBe(reg.id);
    const held = host.ofType("heldKeys").map((m) => m.keys);
    expect(held[0]).toEqual(["shift"]);

    host.push({ type: "pause" });
    expect(await until(() => runner.ctl.paused)).toBe(true);
    host.push({ type: "resume" });
    expect(await until(() => !runner.ctl.paused)).toBe(true);

    host.push({ type: "stop" });
    const result = await run;
    expect(result.stopped).toBe("manual");
    // exit path releases held keys and unregisters the hotkey
    expect(await until(() => host.ofType("unregisterHotkey").length === 1)).toBe(true);
    expect(host.ofType("unregisterHotkey")[0].id).toBe(reg.id);
    expect(await until(() => host.ofType("heldKeys").pop().keys.length === 0)).toBe(true);
    provider.dispose();
    client.close();
  });

  test("hotkeyDone is sent even when the TS layer drops the trigger", async () => {
    const client = await HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "t" });
    const provider = new HostHotkeyProvider(client);
    const runner = new AutomationRunner(
      { name: "hk2", script: `sdk.hotkeys.on("f6", async () => { await sdk.sleep(200); }, { concurrency: "drop" });` },
      svc(),
      { maxDurationMs: 5000, hotkeyProvider: provider }
    );
    provider.bindRunner(runner);
    const run = runner.run();
    await until(() => host.ofType("registerHotkey").length === 1);
    const id = host.ofType("registerHotkey")[0].id;
    host.push({ type: "hotkey", id });
    await sleep(30);
    host.push({ type: "hotkey", id }); // dropped by TS
    expect(await until(() => host.ofType("hotkeyDone").length === 2)).toBe(true);
    host.push({ type: "stop" });
    await run;
    client.close();
  });

  test("tray status + menu item round trip", async () => {
    const client = await HostClient.connect("worker", { endpoint: host.sock, workerId: "w1", name: "t" });
    const provider = new HostHotkeyProvider(client);
    const runner = new AutomationRunner(
      {
        name: "tray",
        script: `sdk.tray.setStatus("farming"); sdk.tray.addMenuItem("Say hi", () => sdk.log("menu-hit")); sdk.keepAlive();`,
      },
      svc(),
      { maxDurationMs: 5000, hotkeyProvider: provider, tray: provider.trayBridge() }
    );
    provider.bindRunner(runner);
    const run = runner.run();
    expect(await until(() => host.ofType("trayMenuItem").length === 1)).toBe(true);
    expect(host.ofType("trayStatus")[0].text).toBe("farming");
    host.push({ type: "trayMenu", id: host.ofType("trayMenuItem")[0].id });
    await sleep(50);
    runner.ctl.stop();
    const result = await run;
    expect(result.logs.map((l) => l.data)).toContainEqual("menu-hit");
    client.close();
  });

  test("runWorker loads the automation, arms from hello, and exits 0 on host stop", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "khproj-"));
    fs.mkdirSync(path.join(proj, ".knowhow", "automations"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".knowhow", "automations", "demo.ts"), `sdk.keepAlive();`);
    const prevCwd = process.cwd();
    try {
      const code = runWorker(
        { name: "demo", cwd: proj },
        { KNOWHOW_HOST_WORKER_ID: "wid", KNOWHOW_HOST_NAME: "demo", KNOWHOW_HOST_ENDPOINT: host.sock },
        svc
      );
      expect(await until(() => host.ofType("hello").length === 1)).toBe(true);
      await sleep(200);
      host.push({ type: "stop" });
      expect(await code).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("parseSingleInstance reads the @automation header", () => {
    expect(parseSingleInstance("/** @automation\n * singleInstance: ignore   # x\n */\nsdk.keepAlive();")).toBe("ignore");
    expect(parseSingleInstance("/** @automation\n * description: hi\n */")).toBe("replace");
    expect(parseSingleInstance("sdk.keepAlive();")).toBe("replace");
  });
});
