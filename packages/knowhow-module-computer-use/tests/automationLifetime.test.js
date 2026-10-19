const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AutomationRunner,
  setKillSwitchArmed,
  isKillSwitchArmed,
  MAX_AUTOMATION_DURATION_MS,
  FakeHotkeyProvider,
  setHotkeyProvider,
} = require("../ts_build/automation");
const { createStore } = require("../ts_build/store");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logsOf = (result) => result.logs.map((l) => l.data);

function makeSvc() {
  const state = {
    keyUps: [],
    window: { title: "Path of Exile", app: "Path of Exile", exe: "PathOfExile.exe" },
  };
  return {
    _state: state,
    async getActiveWindow() { return state.window; },
    async keyDown() {},
    async keyUp(k) { state.keyUps.push(k); },
  };
}

function start(script, svc = makeSvc(), opts = {}) {
  const runner = new AutomationRunner({ name: "lifetime_test", script }, svc, {
    maxDurationMs: 5000,
    gatePollMs: 50,
    ...opts,
  });
  return { runner, promise: runner.run() };
}

/** Resolves "pending" if the promise hasn't settled within ms. */
async function settledWithin(promise, ms) {
  return Promise.race([promise.then(() => "settled"), sleep(ms).then(() => "pending")]);
}

describe("lifetime", () => {
  afterEach(() => {
    setKillSwitchArmed(false);
    setHotkeyProvider(null);
  });

  test("a plain script ends when its body returns", async () => {
    const { promise } = start(`await sdk.sleep(10);`);
    const result = await promise;
    expect(result.stopped).toBe("completed");
  });

  test("keepAlive keeps the run resident after the body returns; stop ends it", async () => {
    const { runner, promise } = start(`sdk.keepAlive(); sdk.keepAlive();`);
    expect(await settledWithin(promise, 300)).toBe("pending");
    expect(runner.retainCount).toBe(1);
    runner.ctl.stop();
    const result = await promise;
    expect(result.stopped).toBe("manual");
  });

  test("exit() ends a resident run as completed", async () => {
    const provider = new FakeHotkeyProvider();
    const { runner, promise } = start(
      `sdk.hotkeys.on("F9", () => sdk.exit());`,
      makeSvc(),
      { hotkeyProvider: provider }
    );
    await sleep(30);
    expect(await settledWithin(promise, 150)).toBe("pending");
    await provider.trigger(provider.ids()[0]);
    const result = await promise;
    expect(result.stopped).toBe("completed");
    expect(provider.unregistered).toHaveLength(1);
    expect(runner.retainCount).toBe(0);
  });

  test("untilExit blocks the body until exit", async () => {
    const { runner, promise } = start(
      `await sdk.untilExit(); sdk.log({ after: true });`
    );
    expect(await settledWithin(promise, 200)).toBe("pending");
    runner.ctl.stop();
    const result = await promise;
    expect(logsOf(result)).toContainEqual({ after: true });
  });

  test("onExit handlers run on stop, error and duration paths", async () => {
    let r = await (async () => {
      const { runner, promise } = start(
        `sdk.onExit(() => sdk.log("bye-stop")); sdk.keepAlive();`
      );
      await sleep(30);
      runner.ctl.stop();
      return promise;
    })();
    expect(logsOf(r)).toContain("bye-stop");

    r = await start(`sdk.onExit(() => sdk.log("bye-error")); throw new Error("x");`).promise;
    expect(r.stopped).toBe("error");
    expect(logsOf(r)).toContain("bye-error");

    r = await start(
      `sdk.onExit(() => sdk.log("bye-dur")); sdk.keepAlive();`,
      makeSvc(),
      { maxDurationMs: 500 }
    ).promise;
    expect(r.stopped).toBe("duration");
    expect(logsOf(r)).toContain("bye-dur");
  });

  test("a hanging onExit handler is capped at 2s and does not block cleanup", async () => {
    const svc = makeSvc();
    const t0 = Date.now();
    const result = await start(
      `await sdk.keyDown("alt");
       sdk.onExit(() => new Promise(() => {}));
       sdk.onExit(() => sdk.log("second"));`,
      svc
    ).promise;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(svc._state.keyUps).toEqual(["alt"]);
    expect(logsOf(result)).toContain("second");
  }, 10000);

  test("runEvery retains while active", async () => {
    const { runner, promise } = start(
      `let n = 0;
       sdk.runEvery(async () => { if (++n >= 3) sdk.ctl.stop(); }, 20);`
    );
    const result = await promise; // body returns immediately, loop keeps it alive
    expect(result.stopped).toBe("manual");
    expect(runner.retainCount).toBe(0);
  });
});

describe("kill switch cap", () => {
  afterEach(() => setKillSwitchArmed(false));

  test("unarmed: clamps to MAX_AUTOMATION_DURATION_MS", async () => {
    expect(isKillSwitchArmed()).toBe(false);
    const runner = new AutomationRunner(
      { name: "cap", script: "" },
      makeSvc(),
      { maxDurationMs: 10_000_000 }
    );
    await runner.run();
    expect(runner.maxDurationMs).toBe(MAX_AUTOMATION_DURATION_MS);
  });

  test("armed: unlimited by default, explicit values honored", async () => {
    setKillSwitchArmed(true);
    expect(isKillSwitchArmed()).toBe(true);
    const a = new AutomationRunner({ name: "cap", script: "" }, makeSvc());
    await a.run();
    expect(a.maxDurationMs).toBe(Infinity);
    const b = new AutomationRunner({ name: "cap", script: "" }, makeSvc(), { maxDurationMs: 10_000_000 });
    await b.run();
    expect(b.maxDurationMs).toBe(10_000_000);
  });

  test("armed, unlimited run can still be stopped manually", async () => {
    setKillSwitchArmed(() => true);
    const { runner, promise } = start(`sdk.keepAlive();`, makeSvc(), { maxDurationMs: undefined });
    await sleep(50);
    runner.ctl.stop();
    expect((await promise).stopped).toBe("manual");
  });
});

describe("store", () => {
  const realHome = process.env.HOME;
  let home;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "khstore-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = realHome;
  });

  test("atomic roundtrip across runs, sanitized names, no tmp leftovers", async () => {
    await start(
      `const s = sdk.store("prefs/../x", { n: 1, list: [] });
       sdk.log({ initial: s.get().n });
       await s.update((v) => { v.n = 2; v.list.push("a"); });
       await s.set({ n: s.get().n + 1, list: s.get().list });`
    ).promise;
    const dir = path.join(home, ".knowhow", "automations-data", "lifetime_test");
    const files = fs.readdirSync(dir);
    expect(files).toEqual(["prefs_.._x.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"))).toEqual({ n: 3, list: ["a"] });

    const result = await start(
      `const s = sdk.store("prefs/../x", { n: 1, list: [], extra: true });
       sdk.log({ n: s.get().n, list: s.get().list, extra: s.get().extra });`
    ).promise;
    expect(logsOf(result)).toContainEqual({ n: 3, list: ["a"], extra: true });
  });

  test("get returns copies; concurrent writes serialize; corrupt file falls back", async () => {
    const s = createStore("direct", "counter", { n: 0 });
    s.get().n = 99;
    expect(s.get().n).toBe(0);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update((v) => { v.n = i; })));
    const file = path.join(home, ".knowhow", "automations-data", "direct", "counter.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).n).toBe(19);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["counter.json"]);
    fs.writeFileSync(file, "{not json");
    expect(createStore("direct", "counter", { n: 5 }).get()).toEqual({ n: 5 });
  });

  test("dry-run does not persist", async () => {
    await start(
      `await sdk.store("dry", { n: 1 }).set({ n: 2 });`,
      makeSvc(),
      { dryRun: true }
    ).promise;
    expect(fs.existsSync(path.join(home, ".knowhow", "automations-data", "lifetime_test", "dry.json"))).toBe(false);
  });
});

describe("hotkeys", () => {
  afterEach(() => setHotkeyProvider(null));

  test("rejects the kill-switch chord, even with a provider", async () => {
    const provider = new FakeHotkeyProvider();
    const result = await start(
      `try { sdk.hotkeys.on("Ctrl+Alt+Escape", () => {}); } catch (e) { sdk.log({ err: e.message }); }
       try { sdk.hotkeys.on("ctrl+alt+esc", () => {}); } catch (e) { sdk.log({ err2: e.message }); }`,
      makeSvc(),
      { hotkeyProvider: provider }
    ).promise;
    const d = logsOf(result);
    expect(d[0].err).toMatch(/kill switch/);
    expect(d[1].err2).toMatch(/kill switch/);
    expect(provider.ids()).toEqual([]);
  });

  test("without a provider throws the host-required error; invalid specs throw first", async () => {
    const result = await start(
      `try { sdk.hotkeys.on("F6", () => {}); } catch (e) { sdk.log({ err: e.message }); }
       try { sdk.hotkeys.on("ctrl+", () => {}); } catch (e) { sdk.log({ bad: e.message }); }
       try { sdk.hotkeys.on("ctrl+alt+esc", () => {}); } catch (e) { sdk.log({ kill: e.message }); }`
    ).promise;
    const d = logsOf(result);
    expect(d[0].err).toBe("global hotkeys require the knowhow computer host (M1)");
    expect(d[1].bad).toMatch(/Invalid hotkey/);
    expect(d[2].kill).toMatch(/kill switch/);
    expect(result.stopped).toBe("completed");
  });

  test("global provider via setHotkeyProvider; concurrency drop", async () => {
    const provider = new FakeHotkeyProvider();
    setHotkeyProvider(provider);
    const { runner, promise } = start(
      `let n = 0;
       sdk.hotkeys.on("F6", async () => { n++; await sdk.sleep(80); sdk.log({ ran: n }); },
         { concurrency: "drop", consume: true, noRepeat: true });`
    );
    await sleep(30);
    const [id] = provider.ids();
    expect(provider.registrations.get(id).options).toMatchObject({
      concurrency: "drop", consume: true, noRepeat: true, anyModifiers: false,
    });
    const first = provider.trigger(id);
    const dropped = provider.trigger(id);
    await Promise.all([first, dropped]);
    await provider.trigger(id); // after completion it runs again
    runner.ctl.stop();
    const result = await promise;
    const ran = logsOf(result).filter((d) => d.ran !== undefined).map((d) => d.ran);
    expect(ran).toEqual([1, 2]);
  });

  test("concurrency queue runs presses in order; parallel overlaps", async () => {
    const provider = new FakeHotkeyProvider();
    const { runner, promise } = start(
      `let q = 0, p = 0;
       sdk.hotkeys.on("F1", async () => { const me = ++q; sdk.log({ qs: me }); await sdk.sleep(40); sdk.log({ qe: me }); }, { concurrency: "queue" });
       sdk.hotkeys.on("F2", async () => { const me = ++p; sdk.log({ ps: me }); await sdk.sleep(40); sdk.log({ pe: me }); }, { concurrency: "parallel" });`,
      makeSvc(),
      { hotkeyProvider: provider }
    );
    await sleep(30);
    const [qid, pid] = provider.ids();
    await Promise.all([provider.trigger(qid), provider.trigger(qid)]);
    await Promise.all([provider.trigger(pid), provider.trigger(pid)]);
    runner.ctl.stop();
    const d = logsOf(await promise).map((x) => Object.entries(x)[0].join(":")).filter((s) => /^[qp][se]:/.test(s));
    expect(d.filter((s) => s.startsWith("q"))).toEqual(["qs:1", "qe:1", "qs:2", "qe:2"]);
    expect(d.filter((s) => s.startsWith("p"))).toEqual(["ps:1", "ps:2", "pe:1", "pe:2"]);
  });

  test("when is checked at trigger time; off() unregisters and releases", async () => {
    const provider = new FakeHotkeyProvider();
    const svc = makeSvc();
    const { runner, promise } = start(
      `const id = sdk.hotkeys.on("F6", () => sdk.log("fired"), { when: { exe: "PathOfExile.exe" } });
       sdk.hotkeys.on("F7", () => sdk.log("off-it"));
       sdk.hotkeys.on("F8", () => sdk.hotkeys.off(id));`,
      svc,
      { hotkeyProvider: provider }
    );
    await sleep(30);
    const [f6, , f8] = provider.ids();
    await provider.trigger(f6); // matching window → fires
    svc._state.window = { title: "Terminal", app: "Terminal", exe: "Terminal" };
    await provider.trigger(f6); // not matching → ignored
    svc._state.window = { title: "Path of Exile", app: "x", exe: "PathOfExile.exe" };
    expect(runner.retainCount).toBe(3);
    await provider.trigger(f8); // unregisters F6
    expect(provider.ids()).not.toContain(f6);
    expect(runner.retainCount).toBe(2);
    runner.ctl.stop();
    const result = await promise;
    expect(logsOf(result).filter((d) => d === "fired")).toHaveLength(1);
  });
});
