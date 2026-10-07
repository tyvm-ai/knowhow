"use strict";

/**
 * Tests for the Automation SDK extension primitive (Contract 1).
 *
 * Covers:
 *  - Extension create() is called before the script runs
 *  - sdk.ext[name] returns the created API
 *  - sdk.extensions() lists registered extensions
 *  - Unknown extension name throws a helpful error
 *  - onDispose callbacks run in the runner's finally block
 *  - signal.aborted is true after the run ends
 *  - A broken create() is logged and skipped (doesn't kill the run)
 *  - RunOptions.extensions is gracefully absent (no extensions)
 */

const {
  AutomationRunner,
} = require("../ts_build/automation");

const {
  AUTOMATION_SDK_EXTENSION,
  buildExtProxy,
  resolveExtensions,
} = require("../ts_build/automationExtensions");

// ── minimal fake ComputerService (same pattern as automation.test.js) ────────

function makeFakeService() {
  return {
    async screenSize() { return { width: 1920, height: 1080 }; },
    async getActiveWindow() { return { title: "Test Window", app: "TestApp" }; },
    async readText() { return []; },
    async findColorRegions() { return []; },
    async findShapes() { return []; },
    async findBoxes() { return []; },
    async findRegions() { return []; },
    async pixelColor() { return "#000000"; },
    async pixelColors() { return []; },
    async moveMouse() {},
    async click() {},
    async drag() {},
    async typeText() {},
    async pressKey() {},
    async hotkey() {},
    async focusWindow() { return true; },
    async selectAccessibilityOption() {},
    async setAccessibilityValue() {},
    async performAccessibilityAction() {},
    async showOverlay() {},
    async clearOverlay() {},
    async accessibilityTrusted() { return false; },
    async accessibilityElements() { return []; },
    async getDriver() { throw new Error("no driver"); },
    async getDisplays() { return []; },
    async screenshot() { return Buffer.from([]); },
  };
}

// ── minimal fake ExtensionsService ──────────────────────────────────────────

function makeExtensionsService(extensions = []) {
  return {
    _extensions: extensions,
    register(owner, ext) { this._extensions.push({ ...ext, owner }); },
    list(type) { return this._extensions.filter((e) => e.type === type); },
    removeOwner(owner) {
      this._extensions = this._extensions.filter((e) => e.owner !== owner);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a short automation script and return the result.
 * opts.extensions can be a fake ExtensionsService.
 */
async function runScript(script, opts = {}) {
  const svc = makeFakeService();
  const spec = { name: "test-ext", script };
  const runner = new AutomationRunner(spec, svc, {
    maxDurationMs: 5000,
    dryRun: true,
    ...opts,
  });
  return runner.run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for buildExtProxy and resolveExtensions
// ─────────────────────────────────────────────────────────────────────────────

describe("buildExtProxy", () => {
  it("returns the registered API by name", () => {
    const api = { doThing: () => 42 };
    const apis = new Map([["myExt", api]]);
    const proxy = buildExtProxy(apis);
    expect(proxy.myExt).toBe(api);
  });

  it("throws a helpful error for unknown names", () => {
    const apis = new Map([["known", {}]]);
    const proxy = buildExtProxy(apis);
    expect(() => proxy.unknown).toThrow(/sdk\.ext\.unknown is not registered/);
    expect(() => proxy.unknown).toThrow(/known/);
  });

  it("lists known extension names via Object.keys", () => {
    const apis = new Map([["a", 1], ["b", 2]]);
    const proxy = buildExtProxy(apis);
    expect(Object.keys(proxy)).toEqual(["a", "b"]);
  });

  it("reports no extensions available when map is empty", () => {
    const proxy = buildExtProxy(new Map());
    expect(() => proxy.anything).toThrow(/\(none\)/);
  });
});

describe("resolveExtensions", () => {
  it("returns empty map when extensionsService is null", async () => {
    let disposeRan = false;
    const ctx = {
      automationName: "test",
      dryRun: false,
      signal: new AbortController().signal,
      isPaused: () => false,
      log: () => {},
      onDispose: () => {},
      sdk: {},
    };
    const apis = await resolveExtensions(null, ctx);
    expect(apis.size).toBe(0);
  });

  it("creates extension APIs and caches them", async () => {
    const created = [];
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "myExt",
      description: "A test extension",
      create(ctx) {
        const api = { ctx, called: true };
        created.push(api);
        return api;
      },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    let disposeRan = false;
    const ctx = {
      automationName: "test",
      dryRun: false,
      signal: new AbortController().signal,
      isPaused: () => false,
      log: () => {},
      onDispose: (fn) => { /* collect */ },
      sdk: {},
    };
    const apis = await resolveExtensions(extSvc, ctx);
    expect(apis.size).toBe(1);
    expect(apis.get("myExt")).toBe(created[0]);
  });

  it("skips extensions with invalid names and logs the error", async () => {
    const logged = [];
    const badExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "bad-name!", // invalid identifier
      description: "bad",
      create() { return {}; },
    };
    const extSvc = makeExtensionsService([badExt]);
    const ctx = {
      automationName: "test",
      dryRun: false,
      signal: new AbortController().signal,
      isPaused: () => false,
      log: (d) => logged.push(d),
      onDispose: () => {},
      sdk: {},
    };
    const apis = await resolveExtensions(extSvc, ctx);
    expect(apis.size).toBe(0);
    expect(logged.some((e) => e.extensionError && /invalid name/.test(e.extensionError))).toBe(true);
  });

  it("logs error and skips a broken extension without killing others", async () => {
    const logged = [];
    const goodExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "good",
      description: "works",
      create() { return { ok: true }; },
    };
    const brokenExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "broken",
      description: "explodes",
      create() { throw new Error("boom"); },
    };
    const extSvc = makeExtensionsService([goodExt, brokenExt]);
    const ctx = {
      automationName: "test",
      dryRun: false,
      signal: new AbortController().signal,
      isPaused: () => false,
      log: (d) => logged.push(d),
      onDispose: () => {},
      sdk: {},
    };
    const apis = await resolveExtensions(extSvc, ctx);
    expect(apis.has("good")).toBe(true);
    expect(apis.has("broken")).toBe(false);
    expect(logged.some((e) => e.extensionError && /boom/.test(e.extensionError))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: AutomationRunner with extensions
// ─────────────────────────────────────────────────────────────────────────────

describe("AutomationRunner with extensions", () => {
  it("exposes sdk.ext and sdk.extensions() when no extensions are registered", async () => {
    const result = await runScript(`
      const extList = sdk.extensions();
      sdk.log({ extList });
      // accessing an unknown extension should throw
      let threw = false;
      try { sdk.ext.unknown; } catch (e) { threw = true; sdk.log({ threw, msg: e.message }); }
    `);
    expect(result.stopped).toBe("completed");
    const extListLog = result.logs.find((l) => l.data && l.data.extList);
    expect(extListLog).toBeTruthy();
    expect(extListLog.data.extList).toEqual([]);
    const threwLog = result.logs.find((l) => l.data && l.data.threw);
    expect(threwLog).toBeTruthy();
    expect(threwLog.data.threw).toBe(true);
  });

  it("exposes registered extension API as sdk.ext[name]", async () => {
    const apiObj = { greet: () => "hello from ext" };
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "greeter",
      description: "Says hello",
      create() { return apiObj; },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    const result = await runScript(`
      const greeter = sdk.ext.greeter;
      sdk.log({ greetResult: greeter.greet() });
      const list = sdk.extensions();
      sdk.log({ list });
    `, { extensions: extSvc });

    expect(result.stopped).toBe("completed");
    const greetLog = result.logs.find((l) => l.data && l.data.greetResult);
    expect(greetLog).toBeTruthy();
    expect(greetLog.data.greetResult).toBe("hello from ext");
    const listLog = result.logs.find((l) => l.data && l.data.list);
    expect(listLog).toBeTruthy();
    expect(listLog.data.list).toEqual([{ name: "greeter", description: "Says hello" }]);
  });

  it("calls onDispose callbacks when the run ends", async () => {
    let disposeCallCount = 0;
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "disposable",
      description: "Has cleanup",
      create(ctx) {
        ctx.onDispose(() => { disposeCallCount++; });
        ctx.onDispose(() => { disposeCallCount++; });
        return { value: 99 };
      },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    const result = await runScript(`
      sdk.log({ val: sdk.ext.disposable.value });
    `, { extensions: extSvc });

    expect(result.stopped).toBe("completed");
    // Both dispose callbacks should have been called
    expect(disposeCallCount).toBe(2);
  });

  it("aborts the signal when the run ends", async () => {
    let capturedSignal = null;
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "signalExt",
      description: "Captures signal",
      create(ctx) {
        capturedSignal = ctx.signal;
        return {};
      },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    const result = await runScript(`sdk.log({ done: true });`, { extensions: extSvc });
    expect(result.stopped).toBe("completed");
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal.aborted).toBe(true);
  });

  it("throws a helpful error with available names for unknown sdk.ext access", async () => {
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "available",
      description: "I am available",
      create() { return {}; },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    const result = await runScript(`
      let msg = "";
      try { sdk.ext.missing; } catch(e) { msg = e.message; }
      sdk.log({ msg });
    `, { extensions: extSvc });
    expect(result.stopped).toBe("completed");
    const msgLog = result.logs.find((l) => l.data && l.data.msg);
    expect(msgLog.data.msg).toMatch(/sdk\.ext\.missing is not registered/);
    expect(msgLog.data.msg).toMatch(/available/);
  });

  it("does not crash the run when an extension's create() throws", async () => {
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "crashy",
      description: "Always fails to create",
      create() { throw new Error("create failed!"); },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    const result = await runScript(`
      sdk.log({ ran: true });
    `, { extensions: extSvc });
    expect(result.stopped).toBe("completed");
    const ranLog = result.logs.find((l) => l.data && l.data.ran);
    expect(ranLog).toBeTruthy();
    // Should have logged the extension error
    const errLog = result.logs.find((l) => l.data && l.data.extensionError);
    expect(errLog).toBeTruthy();
    expect(errLog.data.extensionError).toMatch(/create failed!/);
  });

  it("passes automationName and dryRun to extension context", async () => {
    let capturedCtx = null;
    const fakeExt = {
      type: AUTOMATION_SDK_EXTENSION,
      name: "ctxExt",
      description: "Captures context",
      create(ctx) {
        capturedCtx = { automationName: ctx.automationName, dryRun: ctx.dryRun };
        return {};
      },
    };
    const extSvc = makeExtensionsService([fakeExt]);
    const result = await runScript(`sdk.log({ok:1});`, { extensions: extSvc, dryRun: true });
    expect(result.stopped).toBe("completed");
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.automationName).toBe("test-ext");
    expect(capturedCtx.dryRun).toBe(true);
  });
});
