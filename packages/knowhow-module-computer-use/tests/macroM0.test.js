const { runMacro } = require("../ts_build/macro");
const { ClipboardService } = require("../ts_build/clipboard");

function makeService() {
  const state = { board: "orig", downs: [], ups: [], clicks: [], hotkeys: [] };
  const driver = {
    async clipboardReadText() { return state.board; },
    async clipboardWriteText(t) { state.board = t; },
  };
  return {
    _state: state,
    clipboard: new ClipboardService({ getDriver: async () => driver, pollMs: 5 }),
    async keyDown(k) { state.downs.push(k); },
    async keyUp(k) { state.ups.push(k); },
    async click(button, opts) { state.clicks.push({ button, opts }); },
    async hotkey(...keys) {
      state.hotkeys.push(keys);
      setTimeout(() => { state.board = "SELECTED"; }, 20);
    },
    async pressKey() {},
  };
}

describe("M0 macro steps", () => {
  test("keyDown, keyUp, click (no coords), clipboardSet", async () => {
    const svc = makeService();
    const results = await runMacro(svc, [
      { action: "keyDown", key: "lalt" },
      { action: "click" },
      { action: "keyUp", key: "lalt" },
      { action: "clipboardSet", text: "hello" },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(svc._state.downs).toEqual(["alt"]);
    expect(svc._state.ups).toEqual(["alt"]);
    expect(svc._state.clicks).toEqual([{ button: "left", opts: { double: false } }]);
    expect(svc._state.board).toBe("hello");
  });

  test("copySelection reports the copied text and restores the clipboard", async () => {
    const svc = makeService();
    const results = await runMacro(svc, [
      { action: "copySelection", chord: ["alt", "c"], timeoutMs: 300 },
    ]);
    expect(results).toEqual([{ step: 0, action: "copySelection", ok: true, detail: "SELECTED" }]);
    expect(svc._state.hotkeys).toEqual([["alt", "c"]]);
    expect(svc._state.board).toBe("orig");
  });

  test("copySelection timeout is a soft failure", async () => {
    const svc = makeService();
    svc.hotkey = async () => {};
    const results = await runMacro(svc, [{ action: "copySelection", timeoutMs: 40 }]);
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toMatch(/timeout/);
  });

  test("unsupported services report a failed step instead of throwing", async () => {
    const results = await runMacro({}, [{ action: "clipboardSet", text: "x" }, { action: "keyDown", key: "a" }], { continueOnError: true });
    expect(results.map((r) => r.ok)).toEqual([false, false]);
  });
});
