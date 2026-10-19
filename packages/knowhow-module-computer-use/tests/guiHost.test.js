const fs = require("fs");
const os = require("os");
const path = require("path");
const { startFakeHost } = require("./hostFake");
const { HostClient } = require("../ts_build/host/HostClient");
const { HostHotkeyProvider } = require("../ts_build/host/HostHotkeyProvider");
const { runWorker } = require("../ts_build/host/worker");
const { AutomationRunner, setKillSwitchArmed } = require("../ts_build/automation");
const { setHotkeyProvider } = require("../ts_build/hotkeys");
const dialogs = require("../ts_build/dialogs");

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

d("host GUI backend (fake host)", () => {
  let dir, host, client, provider;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join("/tmp", "khgui-"));
    host = await startFakeHost(dir);
    client = await HostClient.connect("worker", { endpoint: host.sock, workerId: "wg", name: "gui" });
    provider = new HostHotkeyProvider(client);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    setKillSwitchArmed(false);
    setHotkeyProvider(null);
    provider.dispose();
    client.close();
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const svc = () => ({ async getActiveWindow() { return null; }, async keyDown() {}, async keyUp() {} });
  const start = (script, opts = {}) => {
    const runner = new AutomationRunner({ name: "guih", script }, svc(), {
      maxDurationMs: 5000,
      gui: provider.gui(),
      ...opts,
    });
    return { runner, promise: runner.run() };
  };

  test("guiCreate/guiPatch/show/focus/setTitle/destroy wire messages; guiEvent reaches handlers", async () => {
    const { runner, promise } = start(`
      const form = await sdk.gui.form({
        title: "PoE", closeBehavior: "hide",
        layout: { type: "column", children: [
          { id: "inp", type: "input", value: "a" },
          { id: "btn", type: "button", text: "Go" },
          { id: "dd", type: "dropdown", options: ["x", "y"] },
        ] },
      });
      form.on("btn", "click", () => { sdk.log("clicked"); });
      form.on("inp", "change", (ev) => { sdk.log("seen:" + form.get("inp").value + ":" + ev.value); });
      form.on("dd", "select", (ev) => { sdk.log("sel:" + form.get("dd").selected); });
      form.on("close", () => sdk.log("closed"));
      form.set("inp", { value: "b" });
      form.set("btn", { text: "Stop" });
      form.show();
      form.focus("inp");
      form.setTitle("T2");
      sdk.log("ready");
    `);
    expect(await until(() => host.ofType("guiShow").length === 1)).toBe(true);

    const create = host.ofType("guiCreate")[0];
    expect(create.windowId).toMatch(/^w\d+$/);
    expect(create.show).toBe(false);
    expect(create.spec.title).toBe("PoE");
    expect(typeof create.reqId).toBe("number");

    const patches = host.ofType("guiPatch");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      windowId: create.windowId,
      patches: [
        { id: "inp", props: { value: "b" } },
        { id: "btn", props: { text: "Stop" } },
      ],
    });
    // patch is sent before show (ordering)
    const order = host.received.map((m) => m.type).filter((t) => t.startsWith("gui"));
    expect(order.slice(0, 4)).toEqual(["guiCreate", "guiPatch", "guiShow", "guiFocus"]);
    expect(host.ofType("guiFocus")[0].controlId).toBe("inp");
    expect(host.ofType("guiSetTitle")[0].title).toBe("T2");

    const w = create.windowId;
    host.push({ type: "guiEvent", windowId: w, controlId: "btn", event: "click" });
    host.push({ type: "guiEvent", windowId: w, controlId: "inp", event: "change", value: "typed" });
    host.push({ type: "guiEvent", windowId: w, controlId: "dd", event: "select", selected: 1 });
    host.push({ type: "guiEvent", windowId: w, controlId: null, event: "close" });
    host.push({ type: "guiEvent", windowId: "other", controlId: "btn", event: "click" }); // ignored
    await sleep(100);

    runner.ctl.stop();
    const result = await promise;
    const logs = result.logs.map((l) => l.data);
    expect(logs).toEqual(expect.arrayContaining(["clicked", "seen:typed:typed", "sel:1", "closed"]));
    expect(logs.filter((x) => x === "clicked")).toHaveLength(1);
    // runner exit destroys forms on the host
    expect(await until(() => host.ofType("guiDestroy").length === 1)).toBe(true);
    expect(host.ofType("guiDestroy").map((m) => m.windowId)).toEqual([w]);
  });

  test("form.destroy() sends guiDestroy and releases the lifetime", async () => {
    const { promise } = start(`
      const form = await sdk.gui.form({ title: "x", layout: { type: "label", text: "hi" } });
      await sdk.sleep(30);
      form.destroy();
    `);
    const result = await promise;
    expect(result.stopped).toBe("completed");
    expect(await until(() => host.ofType("guiDestroy").length === 1)).toBe(true);
    await sleep(50);
    expect(host.ofType("guiDestroy")).toHaveLength(1); // not re-sent on runner exit
  });

  test("guiCreate error from the host rejects sdk.gui.form", async () => {
    host.handlers.guiCreate = () => ({ ok: false, error: "unsupported platform" });
    const { promise } = start(`
      try { await sdk.gui.form({ title: "x", layout: { type: "label", text: "hi" } }); sdk.log("no-error"); }
      catch (e) { sdk.log("err:" + e.message); }
    `);
    const result = await promise;
    expect(result.stopped).toBe("completed"); // no leaked retain
    expect(result.logs.map((l) => l.data)).toContain("err:unsupported platform");
  });

  test("ui.confirm/alert/prompt go through the host dialog message", async () => {
    const spyC = jest.spyOn(dialogs, "uiConfirm");
    const spyA = jest.spyOn(dialogs, "uiAlert");
    const spyP = jest.spyOn(dialogs, "uiPrompt");
    host.handlers.dialog = (m) => {
      if (m.kind === "confirm") return { result: { button: m.message === "sure?" ? "yes" : "no" } };
      if (m.kind === "prompt") return { result: m.message === "cancel?" ? { button: "cancel" } : { button: "ok", value: "typed:" + m.default } };
      return { result: { button: "ok" } };
    };
    const { promise } = start(`
      sdk.log(await sdk.ui.confirm("sure?", { title: "PoE Crafting" }));
      sdk.log(await sdk.ui.confirm("other"));
      sdk.log(await sdk.ui.prompt("name?", { default: "bob" }));
      sdk.log(await sdk.ui.prompt("legacy?", "old"));
      sdk.log(await sdk.ui.prompt("cancel?"));
      await sdk.ui.alert("hi", { title: "T" });
      sdk.log("done");
    `);
    const result = await promise;
    expect(result.logs.map((l) => l.data)).toEqual(
      expect.arrayContaining([true, false, "typed:bob", "typed:old", null, "done"])
    );
    const dlg = host.ofType("dialog");
    expect(dlg.map((m) => m.kind)).toEqual(["confirm", "confirm", "prompt", "prompt", "prompt", "alert"]);
    expect(dlg[0]).toMatchObject({ title: "PoE Crafting", message: "sure?" });
    expect(dlg[1].title).toBe("guih"); // default title = automation name
    expect(dlg[2].default).toBe("bob");
    expect(dlg[5]).toMatchObject({ title: "T", message: "hi" });
    expect(spyC).not.toHaveBeenCalled();
    expect(spyA).not.toHaveBeenCalled();
    expect(spyP).not.toHaveBeenCalled();
  });

  test("a host dialog error falls back to the local implementation", async () => {
    host.handlers.dialog = () => ({ ok: false, error: "dialogs unsupported on this platform" });
    const spyC = jest.spyOn(dialogs, "uiConfirm").mockResolvedValue(true);
    const spyA = jest.spyOn(dialogs, "uiAlert").mockResolvedValue(undefined);
    const spyP = jest.spyOn(dialogs, "uiPrompt").mockResolvedValue("local");
    const { promise } = start(`
      sdk.log(await sdk.ui.confirm("q?", { title: "Ti" }));
      sdk.log(await sdk.ui.prompt("p?", { default: "d" }));
      await sdk.ui.alert("a");
    `);
    const result = await promise;
    const logs = result.logs.map((l) => l.data);
    expect(logs).toEqual(expect.arrayContaining([true, "local"]));
    expect(logs.filter((l) => l && l.uiFallback)).toHaveLength(3);
    expect(spyC).toHaveBeenCalledWith("q?", { title: "Ti" });
    expect(spyP).toHaveBeenCalledWith("p?", "d", { title: undefined });
    expect(spyA).toHaveBeenCalled();
  });

  test("dry-run dialogs never reach the host", async () => {
    const { promise } = start(`sdk.log(await sdk.ui.confirm("x")); await sdk.ui.alert("y");`, { dryRun: true });
    const result = await promise;
    expect(result.logs.map((l) => l.data)).toContain(false);
    expect(host.ofType("dialog")).toHaveLength(0);
  });

  test("ui.tooltip goes through the host; host error falls back to logging", async () => {
    const { promise } = start(`await sdk.ui.tooltip("KEEP", { ms: 1300 }); await sdk.ui.tooltip("");`);
    await promise;
    const tips = host.ofType("tooltip");
    expect(tips[0]).toMatchObject({ text: "KEEP", ms: 1300, x: null, y: null });
    expect(tips[1].text).toBe("");
    host.received.length = 0;
    host.handlers.tooltip = () => ({ ok: false, error: "unsupported" });
    const { promise: p2 } = start(`await sdk.ui.tooltip("Hi", { ms: 10 });`);
    const result = await p2;
    const logs = result.logs.map((l) => l.data);
    expect(logs).toContainEqual(expect.objectContaining({ uiFallback: "tooltip" }));
    expect(logs).toContainEqual(expect.objectContaining({ tooltip: "Hi", ms: 10 }));
  });

  test("runWorker wires the GUI backend (one connection serves hotkeys + gui)", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "khguiproj-"));
    fs.mkdirSync(path.join(proj, ".knowhow", "automations"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".knowhow", "automations", "guiapp.ts"),
      `const form = await sdk.gui.form({ title: "W", closeBehavior: "exit", layout: { type: "button", id: "b", text: "x" } });
       form.show();
       sdk.hotkeys.on("F7", () => form.show());`
    );
    const prevCwd = process.cwd();
    try {
      const code = runWorker(
        { name: "guiapp", cwd: proj },
        { KNOWHOW_HOST_WORKER_ID: "wid2", KNOWHOW_HOST_NAME: "guiapp", KNOWHOW_HOST_ENDPOINT: host.sock },
        svc
      );
      expect(await until(() => host.ofType("guiShow").length === 1 && host.ofType("registerHotkey").length === 1)).toBe(true);
      const w = host.ofType("guiCreate").find((m) => m.spec.title === "W").windowId;
      // close with closeBehavior "exit" stops the automation => worker exits 0
      host.push({ type: "guiEvent", windowId: w, controlId: null, event: "close" });
      expect(await code).toBe(0);
      expect(await until(() => host.ofType("guiDestroy").length >= 1)).toBe(true);
      expect(host.ofType("guiDestroy").map((m) => m.windowId)).toContain(w);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
