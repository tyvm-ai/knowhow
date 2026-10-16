const { computerUseTypeText, computerUseHotkey, computerUsePressKey, activateInputTarget } = require("../ts_build/tools");
const { appNameMatches } = require("../ts_build/ComputerService");

function harness({ front = { id: 1, app: "Ghostty", title: "tmux" }, windows, activateWorks = true } = {}) {
  const all = windows || [front, { id: 7, app: "Obsidian", title: "Untitled" }];
  let active = front;
  const calls = [];
  const service = {
    async getActiveWindow() { return active; },
    async activateApp(app) {
      calls.push(["activateApp", app]);
      if (!activateWorks) return false;
      const w = all.find((c) => appNameMatches(c.app, app));
      if (w) active = w;
      return !!w;
    },
    async focusWindowById(id) {
      calls.push(["focusWindowById", id]);
      const w = all.find((c) => c.id === id);
      if (w) active = w;
      return !!w;
    },
    async typeText(text) { calls.push(["type", text, active.app]); },
    async pressKey(key) { calls.push(["key", key, active.app]); },
    async hotkey(...keys) { calls.push(["hotkey", keys.join("+"), active.app]); },
    async accessibilityElements() { return []; },
  };
  return { tools: { getContext: () => ({ ComputerUse: service }) }, service, calls };
}

describe("input target activation", () => {
  test("appNameMatches is case-insensitive and allows partial names", () => {
    expect(appNameMatches("Google Chrome", "chrome")).toBe(true);
    expect(appNameMatches("Obsidian", "Obsidian.app")).toBe(true);
    expect(appNameMatches("Ghostty", "Obsidian")).toBe(false);
    expect(appNameMatches(undefined, "Obsidian")).toBe(false);
  });

  test("typeText activates the named app before typing, even if the agent's terminal is in front", async () => {
    const { tools, calls } = harness();
    const result = await computerUseTypeText.call(tools, "hello", undefined, false, undefined, "Obsidian");
    expect(calls).toEqual([["activateApp", "Obsidian"], ["type", "hello", "Obsidian"]]);
    expect(result).toContain("Obsidian");
  });

  test("the terminal itself can be the target", async () => {
    const { tools, calls } = harness();
    await computerUseHotkey.call(tools, ["control", "c"], "Ghostty");
    expect(calls).toEqual([["hotkey", "control+c", "Ghostty"]]);
  });

  test("refuses input when the app cannot be activated", async () => {
    const { tools, calls } = harness({ activateWorks: false });
    await expect(computerUsePressKey.call(tools, "Enter", "Obsidian")).rejects.toThrow(/could not activate app "Obsidian"/);
    expect(calls.some((c) => c[0] === "key")).toBe(false);
  });

  test("refuses input with no target at all", async () => {
    const { tools } = harness();
    await expect(computerUsePressKey.call(tools, "Enter")).rejects.toThrow(/without a target/);
  });

  test("a window ID is focused and must belong to the named app", async () => {
    const { service, calls } = harness();
    await activateInputTarget(service, "test", "Obsidian", 7);
    expect(calls).toEqual([["focusWindowById", 7]]);
    await expect(activateInputTarget(service, "test", "Ghostty", 7)).rejects.toThrow(/expected app "Ghostty" \/ window ID 7/);
  });
});
