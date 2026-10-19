const { Form, HeadlessGuiBackend, validateSpec, GuiSpecError } = require("../ts_build/gui");
const { AutomationRunner, setKillSwitchArmed } = require("../ts_build/automation");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const spec = (over = {}) => ({
  title: "T",
  closeBehavior: "hide",
  layout: {
    type: "column",
    children: [
      { id: "name", type: "input", label: "Name", value: "abc" },
      { id: "n", type: "number", min: 2 },
      { id: "chk", type: "checkbox", text: "On" },
      { id: "dd", type: "dropdown", options: ["a", "b", "c"], selected: 1 },
      { id: "lb", type: "listbox", items: ["x"] },
      { id: "status", type: "label", text: "Idle" },
      { id: "go", type: "button", text: "Go" },
      { type: "row", children: [{ id: "bar", type: "progress", value: 5 }] },
    ],
  },
  ...over,
});

async function mk(over, hooksOver = {}) {
  const backend = new HeadlessGuiBackend();
  const logs = [];
  const form = await Form.create("w1", spec(over), backend, { log: (d) => logs.push(d), ...hooksOver });
  return { form, backend, logs };
}

describe("spec validation", () => {
  const bad = (s) => {
    try {
      validateSpec(s);
    } catch (e) {
      expect(e).toBeInstanceOf(GuiSpecError);
      return e.message;
    }
    throw new Error("expected validation to fail");
  };

  test("accepts a valid spec", () => {
    expect(() => validateSpec(spec())).not.toThrow();
  });
  test("duplicate ids are reported with both locations", () => {
    const m = bad({ title: "x", layout: { type: "row", children: [
      { id: "a", type: "label", text: "1" }, { id: "a", type: "label", text: "2" } ] } });
    expect(m).toMatch(/duplicate id "a"/);
    expect(m).toMatch(/layout\.children\[1\]/);
  });
  test("unknown type suggests the closest name", () => {
    const m = bad({ title: "x", layout: { type: "buton", text: "x" } });
    expect(m).toMatch(/unknown node type "buton"/);
    expect(m).toMatch(/Did you mean "button"/);
  });
  test("missing required props and wrong types", () => {
    const m = bad({ title: 3, layout: { type: "column", children: [
      { type: "button" }, { type: "dropdown", options: "x" }, { type: "grid", children: [] } ] } });
    expect(m).toMatch(/"title" must be a string/);
    expect(m).toMatch(/button\): "text" is required/);
    expect(m).toMatch(/"options" is required and must be an array of strings/);
    expect(m).toMatch(/"columns" is required/);
  });
  test("unknown property and bad closeBehavior", () => {
    const m = bad({ title: "x", closeBehavior: "quit", layout: { type: "label", text: "t", txt: "x" } });
    expect(m).toMatch(/closeBehavior/);
    expect(m).toMatch(/unknown property "txt"/);
  });
  test("layout is required", () => {
    expect(bad({ title: "x" })).toMatch(/"layout" is required/);
  });
});

describe("Form mirror", () => {
  test("initial state defaults and get() copies", async () => {
    const { form } = await mk();
    expect(form.get("name")).toMatchObject({ value: "abc", enabled: true, visible: true });
    expect(form.get("n").value).toBe(2);
    expect(form.get("chk").checked).toBe(false);
    expect(form.get("dd")).toMatchObject({ options: ["a", "b", "c"], selected: 1 });
    expect(form.get("lb").selected).toBe(-1);
    expect(form.get("bar")).toMatchObject({ value: 5, max: 100 });
    form.get("dd").options.push("zzz");
    expect(form.get("dd").options).toHaveLength(3);
    expect(form.visible).toBe(false);
  });

  test("get/set on unknown id throws helpful errors", async () => {
    const { form } = await mk();
    expect(() => form.get("nmae")).toThrow(/Did you mean "name"/);
    expect(() => form.set("status", { value: "x" })).toThrow(/not patchable on a label/);
    expect(() => form.set("dd", { selected: 1.5 })).toThrow(/integer/);
  });

  test("set updates the mirror synchronously and batches into one guiPatch per tick", async () => {
    const { form, backend } = await mk();
    form.set("status", { text: "A" });
    form.set("name", { value: "x" });
    form.set("status", { text: "B", enabled: false });
    expect(form.get("status")).toMatchObject({ text: "B", enabled: false });
    expect(backend.opsOf("patch")).toHaveLength(0);
    await Promise.resolve();
    const patches = backend.opsOf("patch");
    expect(patches).toHaveLength(1);
    expect(patches[0].patches).toEqual([
      { id: "status", props: { text: "B", enabled: false } },
      { id: "name", props: { value: "x" } },
    ]);
    form.set("status", { text: "C" });
    await Promise.resolve();
    expect(backend.opsOf("patch")).toHaveLength(2);
  });

  test("pending patches are flushed before show/hide to preserve order", async () => {
    const { form, backend } = await mk();
    form.set("status", { text: "A" });
    form.show();
    expect(backend.ops.map((o) => o.op).slice(-2)).toEqual(["patch", "show"]);
    expect(form.visible).toBe(true);
    form.hide();
    expect(form.visible).toBe(false);
  });

  test("replacing options invalidates an out-of-range selection", async () => {
    const { form } = await mk();
    form.set("dd", { options: ["only"] });
    expect(form.get("dd").selected).toBe(-1);
    form.set("dd", { options: ["p", "q"], selected: 1 });
    expect(form.get("dd").selected).toBe(1);
  });
});

describe("Form events", () => {
  test("change/select/checked update the mirror BEFORE handlers run", async () => {
    const { form, backend } = await mk();
    const seen = [];
    form.on("name", "change", (ev) => seen.push(["name", form.get("name").value, ev.value]));
    form.on("dd", "select", (ev) => seen.push(["dd", form.get("dd").selected, ev.selected]));
    form.on("chk", "change", (ev) => seen.push(["chk", form.get("chk").checked, ev.checked]));
    form.on("n", "change", (ev) => seen.push(["n", form.get("n").value, ev.value]));
    backend.injectControl("w1", "name", "change", { value: "hello" });
    backend.injectControl("w1", "dd", "select", { selected: 2 });
    backend.injectControl("w1", "chk", "change", { checked: true });
    backend.injectControl("w1", "n", "change", { value: 7 });
    expect(seen).toEqual([["name", "hello", "hello"], ["dd", 2, 2], ["chk", true, true], ["n", 7, 7]]);
  });

  test("click handlers receive {id,event}; unsubscribe works", async () => {
    const { form, backend } = await mk();
    const calls = [];
    const off = form.on("go", "click", (ev) => calls.push(ev));
    backend.injectControl("w1", "go", "click");
    off();
    backend.injectControl("w1", "go", "click");
    expect(calls).toEqual([{ id: "go", event: "click" }]);
  });

  test("handler errors (sync and async) are logged, not thrown", async () => {
    const { form, backend, logs } = await mk();
    form.on("go", "click", () => { throw new Error("boom"); });
    form.on("go", "click", async () => { throw new Error("async boom"); });
    let ran = false;
    form.on("go", "click", () => { ran = true; });
    expect(() => backend.injectControl("w1", "go", "click")).not.toThrow();
    await sleep(5);
    expect(ran).toBe(true);
    const errs = logs.filter((l) => l.guiHandlerError).map((l) => l.error);
    expect(errs).toEqual(expect.arrayContaining(["boom", "async boom"]));
  });

  test("async handlers are not serialized (they run as events come)", async () => {
    const { form, backend } = await mk();
    const order = [];
    form.on("go", "click", async () => { order.push("start"); await sleep(30); order.push("end"); });
    backend.injectControl("w1", "go", "click");
    backend.injectControl("w1", "go", "click");
    expect(order).toEqual(["start", "start"]);
    await sleep(50);
  });

  test("on() validates ids and event names", async () => {
    const { form } = await mk();
    expect(() => form.on("nope", "click", () => {})).toThrow(/no control with that id/);
    expect(() => form.on("go", "clck", () => {})).toThrow(/Did you mean "click"/);
    expect(() => form.on("closed", () => {})).toThrow(/window events/);
  });

  test("window-level show/hide/close events", async () => {
    const { form, backend } = await mk();
    const seen = [];
    for (const e of ["show", "hide", "close"]) form.on(e, (ev) => seen.push(ev.event));
    form.show();
    form.show(); // no duplicate event
    form.hide();
    form.show();
    backend.injectClose("w1");
    expect(seen).toEqual(["show", "hide", "show", "close"]);
    expect(form.visible).toBe(false);
    expect(form.destroyed).toBe(false); // closeBehavior hide
  });

  test("closeBehavior destroy destroys the form; exit calls onExit", async () => {
    const d = await mk({ closeBehavior: "destroy" });
    d.backend.injectClose("w1");
    expect(d.form.destroyed).toBe(true);
    expect(d.backend.isDestroyed("w1")).toBe(true);

    let exited = 0;
    const e = await mk({ closeBehavior: "exit" }, { onExit: () => exited++ });
    e.backend.injectClose("w1");
    expect(exited).toBe(1);
    expect(e.form.destroyed).toBe(false);
  });

  test("destroy is idempotent, flushes first, and later ops are no-ops", async () => {
    let destroyed = 0;
    const { form, backend } = await mk({}, { onDestroyed: () => destroyed++ });
    form.set("status", { text: "bye" });
    form.destroy();
    form.destroy();
    expect(destroyed).toBe(1);
    expect(backend.ops.map((o) => o.op).slice(-2)).toEqual(["patch", "destroy"]);
    form.set("status", { text: "later" });
    form.show();
    await Promise.resolve();
    expect(backend.opsOf("destroy")).toHaveLength(1);
    expect(backend.opsOf("show")).toHaveLength(0);
    expect(form.get("status").text).toBe("bye"); // set after destroy is ignored
  });

  test("focus/setTitle go to the backend; focus validates the control id", async () => {
    const { form, backend } = await mk();
    form.focus("name");
    form.setTitle("New");
    expect(backend.opsOf("focus")[0]).toMatchObject({ controlId: "name" });
    expect(backend.opsOf("setTitle")[0]).toMatchObject({ title: "New" });
    expect(() => form.focus("zzz")).toThrow(/no control/);
  });
});

describe("sdk.gui lifetime (headless)", () => {
  const svc = () => ({ async getActiveWindow() { return null; }, async keyDown() {}, async keyUp() {} });
  const start = (script, opts = {}) => {
    const gui = new HeadlessGuiBackend();
    const runner = new AutomationRunner({ name: "gui_test", script }, svc(), { maxDurationMs: 5000, gui, ...opts });
    return { runner, gui, promise: runner.run() };
  };
  const settled = (p, ms) => Promise.race([p.then(() => "settled"), sleep(ms).then(() => "pending")]);
  afterEach(() => setKillSwitchArmed(false));

  test("top-level await + TS syntax work; a form keeps the automation alive until destroy", async () => {
    const { runner, gui, promise } = start(`
      const title: string = "Hello";
      const form = await sdk.gui.form({ title, layout: { type: "label", id: "l", text: "hi" } });
      form.show();
    `);
    expect(await settled(promise, 300)).toBe("pending");
    expect(runner.retainCount).toBe(1);
    expect(gui.isShown(gui.lastWindowId())).toBe(true);
    runner.ctl.stop();
    const result = await promise;
    expect(result.stopped).toBe("manual");
    // forms are destroyed on runner exit
    expect(gui.isDestroyed(gui.lastWindowId())).toBe(true);
  });

  test("form.destroy() releases the retain so the run completes", async () => {
    const { gui, promise } = start(`
      const form = await sdk.gui.form({ title: "x", layout: { type: "label", text: "hi" } });
      await sdk.sleep(50);
      form.destroy();
    `);
    const result = await promise;
    expect(result.stopped).toBe("completed");
    expect(gui.isDestroyed(gui.lastWindowId())).toBe(true);
  });

  test("closeBehavior exit stops the automation", async () => {
    const { gui, promise } = start(`
      const form = await sdk.gui.form({ title: "x", closeBehavior: "exit", layout: { type: "label", text: "hi" } });
      form.show();
    `);
    await sleep(100);
    expect(await settled(promise, 100)).toBe("pending");
    gui.injectClose(gui.lastWindowId());
    const result = await promise;
    expect(result.stopped).toBe("completed");
  });

  test("closeBehavior destroy releases the lifetime", async () => {
    const { gui, promise } = start(`
      const form = await sdk.gui.form({ title: "x", closeBehavior: "destroy", layout: { type: "label", text: "hi" } });
      form.show();
    `);
    await sleep(100);
    gui.injectClose(gui.lastWindowId());
    expect((await promise).stopped).toBe("completed");
  });

  test("closeBehavior hide keeps the form (and the run) alive", async () => {
    const { runner, gui, promise } = start(`
      const form = await sdk.gui.form({ title: "x", layout: { type: "label", text: "hi" } });
      form.show();
    `);
    await sleep(100);
    gui.injectClose(gui.lastWindowId());
    expect(await settled(promise, 150)).toBe("pending");
    expect(runner.retainCount).toBe(1);
    runner.ctl.stop();
    await promise;
  });

  test("invalid spec rejects sdk.gui.form without leaking a retain", async () => {
    const { promise } = start(`
      try { await sdk.gui.form({ title: "x", layout: { type: "nope" } }); }
      catch (e) { sdk.log({ caught: e.message }); }
    `);
    const result = await promise;
    expect(result.stopped).toBe("completed");
    expect(result.logs.map((l) => l.data).find((d) => d.caught).caught).toMatch(/unknown node type "nope"/);
  });

  test("without RunOptions.gui a headless backend is used and ops are logged", async () => {
    const runner = new AutomationRunner(
      { name: "gui_test2", script: `const f = await sdk.gui.form({ title: "x", layout: { type: "label", id: "l", text: "hi" } }); f.set("l", { text: "z" }); f.destroy();` },
      svc(),
      { maxDurationMs: 5000 }
    );
    const result = await runner.run();
    expect(result.stopped).toBe("completed");
    const ops = result.logs.map((l) => l.data.gui).filter(Boolean);
    expect(ops).toEqual(["create", "patch", "destroy"]);
  });
});
