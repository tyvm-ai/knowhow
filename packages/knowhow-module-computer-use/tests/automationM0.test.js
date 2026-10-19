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
const { ClipboardService } = require("../ts_build/clipboard");
const { createStore } = require("../ts_build/store");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSvc(overrides = {}) {
  const state = {
    clicks: [],
    keyDowns: [],
    keyUps: [],
    hotkeys: [],
    keys: [],
    clipboard: "user text",
    window: { title: "Path of Exile", app: "Path of Exile", exe: "C:\\PoE\\PathOfExile.exe" },
  };
  const driver = {
    async clipboardReadText() { return state.clipboard; },
    async clipboardWriteText(t) { state.clipboard = t; },
  };
  const svc = {
    _state: state,
    clipboard: new ClipboardService({ getDriver: async () => driver, pollMs: 5 }),
    async getActiveWindow() { return state.window; },
    async moveMouse() {},
    async click(button) { state.clicks.push(button); },
    async keyDown(k) { state.keyDowns.push(k); },
    async keyUp(k) { state.keyUps.push(k); },
    async pressKey(k) { state.keys.push(k); },
    async hotkey(...keys) { state.hotkeys.push(keys); },
  };
  return Object.assign(svc, overrides);
}

const logsOf = (result) => result.logs.map((l) => l.data);

function start(script, svc, opts = {}) {
  const runner = new AutomationRunner({ name: "m0_test", script }, svc, {
    maxDurationMs: 5000,
    gatePollMs: 50,
    ...opts,
  });
  const promise = runner.run();
  return { runner, promise };
}

describe("M0 SDK: input", () => {
  test("click + mod alias in hotkey/key/keyDown", async () => {
    const svc = makeSvc();
    const result = await start(
      `await sdk.click("right");
       await sdk.hotkey(["mod", "c"]);
       await sdk.key("mod");
       await sdk.keyDown("lalt"); await sdk.keyUp("lalt");`,
      svc
    ).promise;
    const mod = process.platform === "darwin" ? "command" : "control";
    expect(svc._state.clicks).toEqual(["right"]);
    expect(svc._state.hotkeys).toEqual([[mod, "c"]]);
    expect(svc._state.keys).toEqual([mod]);
    expect(svc._state.keyDowns).toEqual(["alt"]);
    expect(svc._state.keyUps).toEqual(["alt"]);
    expect(result.actions.map((a) => a.kind)).toEqual(["click", "hotkey", "key", "keyDown", "keyUp"]);
  });

  test("dry-run records but suppresses click/keyDown/keyUp/clipboard", async () => {
    const svc = makeSvc();
    const result = await start(
      `await sdk.click(); await sdk.keyDown("alt"); await sdk.keyUp("alt");
       await sdk.clipboard.writeText("zzz");
       const t = await sdk.copySelection(); sdk.log({ t });`,
      svc,
      { dryRun: true }
    ).promise;
    expect(svc._state.clicks).toEqual([]);
    expect(svc._state.keyDowns).toEqual([]);
    expect(svc._state.clipboard).toBe("user text");
    expect(result.actions.map((a) => a.kind)).toEqual([
      "click", "keyDown", "keyUp", "clipboardWrite", "copySelection",
    ]);
    expect(result.actions.every((a) => a.suppressed)).toBe(true);
    expect(logsOf(result)).toContainEqual({ t: null });
  });

  test("held keys are released when the run is stopped", async () => {
    const svc = makeSvc();
    const { runner, promise } = start(
      `await sdk.keyDown("alt");
       while (!sdk.ctl.stopped) await sdk.sleep(10);`,
      svc
    );
    await sleep(60);
    expect(svc._state.keyUps).toEqual([]);
    runner.ctl.stop();
    const result = await promise;
    expect(result.stopped).toBe("manual");
    expect(svc._state.keyDowns).toEqual(["alt"]);
    expect(svc._state.keyUps).toEqual(["alt"]);
    expect(runner.heldKeyNames()).toEqual([]);
  });

  test("held keys are released when the body throws", async () => {
    const svc = makeSvc();
    const result = await start(
      `await sdk.keyDown("shift"); throw new Error("boom");`,
      svc
    ).promise;
    expect(result.stopped).toBe("error");
    expect(svc._state.keyUps).toEqual(["shift"]);
  });

  test("held keys are released when the duration elapses", async () => {
    const svc = makeSvc();
    const result = await start(
      `await sdk.keyDown("ctrl");
       while (!sdk.ctl.stopped) await sdk.sleep(10);`,
      svc,
      { maxDurationMs: 500 }
    ).promise;
    expect(result.stopped).toBe("duration");
    expect(svc._state.keyUps).toEqual(["ctrl"]);
  });

  test("withKeysHeld releases in finally, even on error", async () => {
    const svc = makeSvc();
    const result = await start(
      `try {
         await sdk.withKeysHeld(["lalt"], async () => { await sdk.click(); throw new Error("inner"); });
       } catch (e) { sdk.log({ caught: e.message }); }`,
      svc
    ).promise;
    expect(svc._state.keyDowns).toEqual(["alt"]);
    expect(svc._state.keyUps).toEqual(["alt"]);
    expect(svc._state.clicks).toEqual(["left"]);
    expect(logsOf(result)).toContainEqual({ caught: "inner" });
  });

  test("keyUp of a held key is allowed while paused (no stuck modifiers)", async () => {
    const svc = makeSvc();
    const { runner, promise } = start(
      `await sdk.keyDown("alt");
       await sdk.sleep(80);
       await sdk.keyUp("alt");`,
      svc
    );
    await sleep(30);
    runner.ctl.paused = true;
    const result = await promise;
    expect(svc._state.keyUps).toEqual(["alt"]);
    expect(result.actions.find((a) => a.kind === "keyUp").suppressed).toBe(false);
  });

  test("keyState falls back to false with a single warning", async () => {
    const svc = makeSvc();
    const result = await start(
      `sdk.log({ a: await sdk.keyState("alt", { physical: true }) });
       sdk.log({ b: await sdk.keyState("alt") });`,
      svc
    ).promise;
    const warnings = logsOf(result).filter((d) => d.warning);
    expect(warnings).toHaveLength(1);
    expect(logsOf(result)).toContainEqual({ a: false });
    expect(logsOf(result)).toContainEqual({ b: false });
  });

  test("keyState uses the service when supported", async () => {
    const calls = [];
    const svc = makeSvc({
      async keyState(key, physical) { calls.push([key, physical]); return true; },
    });
    const result = await start(
      `sdk.log({ down: await sdk.keyState("mod", { physical: true }) });`,
      svc
    ).promise;
    const mod = process.platform === "darwin" ? "command" : "control";
    expect(calls).toEqual([[mod, true]]);
    expect(logsOf(result)).toContainEqual({ down: true });
  });

  test("random is an inclusive integer", async () => {
    const result = await start(
      `const seen = new Set();
       for (let i = 0; i < 300; i++) seen.add(sdk.random(3, 5));
       sdk.log({ seen: [...seen].sort() });
       sdk.log({ same: sdk.random(7, 7), swapped: Number.isInteger(sdk.random(9, 2)) });`,
      makeSvc()
    ).promise;
    const d = logsOf(result);
    expect(d[0].seen).toEqual([3, 4, 5]);
    expect(d[1]).toEqual({ same: 7, swapped: true });
  });

  test("window.isActive matches exe/app/bundleId/title", async () => {
    const result = await start(
      `sdk.log({
         exe: await sdk.window.isActive({ exe: ["pathofexile", "Other.exe"] }),
         app: await sdk.window.isActive({ app: "path of" }),
         nope: await sdk.window.isActive({ exe: "chrome" }),
         title: await sdk.window.isActive({ titleIncludes: "exile" }),
       });`,
      makeSvc()
    ).promise;
    expect(logsOf(result)[0]).toEqual({ exe: true, app: true, nope: false, title: true });
  });

  test("requiredWindow accepts exe selectors", async () => {
    const svc = makeSvc();
    const result = await start(
      `await sdk.requiredWindow({ exe: "PathOfExile.exe" });
       await sdk.click();`,
      svc
    ).promise;
    expect(svc._state.clicks).toEqual(["left"]);
    expect(result.ranWithoutWindowGate).toBeFalsy();
  });
});

describe("M0 SDK: clipboard", () => {
  test("copySelection returns text and restores the snapshot", async () => {
    const svc = makeSvc();
    svc.hotkey = async (...keys) => {
      svc._state.hotkeys.push(keys);
      setTimeout(() => { svc._state.clipboard = "ITEM TEXT"; }, 30);
    };
    const result = await start(
      `const t = await sdk.copySelection({ timeoutMs: 500 }); sdk.log({ t });`,
      svc
    ).promise;
    expect(logsOf(result)).toContainEqual({ t: "ITEM TEXT" });
    expect(svc._state.clipboard).toBe("user text");
    const mod = process.platform === "darwin" ? "command" : "control";
    expect(svc._state.hotkeys).toEqual([[mod, "c"]]);
  });

  test("copySelection returns null on timeout and still restores", async () => {
    const svc = makeSvc();
    const result = await start(
      `const t = await sdk.copySelection({ timeoutMs: 80, chord: ["alt", "c"] }); sdk.log({ t });`,
      svc
    ).promise;
    expect(logsOf(result)).toContainEqual({ t: null });
    expect(svc._state.clipboard).toBe("user text");
    expect(svc._state.hotkeys).toEqual([["alt", "c"]]);
  });

  test("copySelection restore:false leaves the copied text", async () => {
    const svc = makeSvc();
    svc.hotkey = async () => { svc._state.clipboard = "COPIED"; };
    await start(`await sdk.copySelection({ restore: false });`, svc).promise;
    expect(svc._state.clipboard).toBe("COPIED");
  });

  test("clipboard read/write/snapshot/restore/waitForChange", async () => {
    const svc = makeSvc();
    const { promise } = start(
      `const snap = await sdk.clipboard.snapshot();
       await sdk.clipboard.writeText("tmp");
       sdk.log({ read: await sdk.clipboard.readText() });
       const changed = sdk.clipboard.waitForChange({ timeoutMs: 400 });
       await sdk.sleep(30);
       sdk.log({ changed: await changed });
       sdk.log({ timedOut: await sdk.clipboard.waitForChange({ timeoutMs: 40 }) });
       await sdk.clipboard.restore(snap);`,
      svc
    );
    await sleep(60);
    svc._state.clipboard = "external change";
    const result = await promise;
    const d = logsOf(result);
    expect(d).toContainEqual({ read: "tmp" });
    expect(d).toContainEqual({ changed: true });
    expect(d).toContainEqual({ timedOut: false });
    expect(svc._state.clipboard).toBe("user text");
  });
});

describe("clipboard CLI fallback", () => {
  test("macOS uses pbpaste/pbcopy", async () => {
    let board = "mac";
    const calls = [];
    const cb = new ClipboardService({
      platform: "darwin",
      async runCommand(cmd, args, input) {
        calls.push(cmd);
        if (cmd === "pbpaste") return board;
        if (cmd === "pbcopy") { board = input; return ""; }
        throw new Error("unexpected " + cmd);
      },
    });
    expect(await cb.readText()).toBe("mac");
    await cb.writeText("héllo");
    expect(board).toBe("héllo");
    expect(calls).toEqual(["pbpaste", "pbcopy"]);
  });

  test("Linux tries wl-clipboard then xclip", async () => {
    let board = "x11";
    const calls = [];
    const cb = new ClipboardService({
      platform: "linux",
      async runCommand(cmd, args, input) {
        calls.push(cmd);
        if (cmd.startsWith("wl-")) throw new Error("not found");
        if (cmd === "xclip" && args.includes("-o")) return board;
        if (cmd === "xclip") { board = input; return ""; }
        throw new Error("unexpected " + cmd);
      },
    });
    expect(await cb.readText()).toBe("x11");
    await cb.writeText("abc");
    expect(board).toBe("abc");
    // After the first success the working tool is remembered.
    expect(calls).toEqual(["wl-paste", "xclip", "xclip"]);
  });

  test("Windows pipes UTF-8 through PowerShell", async () => {
    const seen = [];
    const cb = new ClipboardService({
      platform: "win32",
      async runCommand(cmd, args, input) {
        seen.push({ cmd, script: args[args.length - 1], input });
        return "win";
      },
    });
    expect(await cb.readText()).toBe("win");
    await cb.writeText("日本");
    expect(seen[0].cmd).toBe("powershell");
    expect(seen[0].script).toMatch(/Get-Clipboard/);
    expect(seen[1].script).toMatch(/Set-Clipboard/);
    expect(seen[1].input).toBe("日本");
  });

  test("native unsupported errors fall back to the CLI", async () => {
    const cb = new ClipboardService({
      platform: "darwin",
      getDriver: async () => ({
        async clipboardReadText() {
          const e = new Error("nope"); e.unsupported = true; throw e;
        },
      }),
      async runCommand() { return "from cli"; },
    });
    expect(await cb.readText()).toBe("from cli");
  });
});
