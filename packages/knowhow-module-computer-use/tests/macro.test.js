const { runMacro } = require("../ts_build/macro");

function makeService() {
  const state = { traversals: 0, selections: [], values: [], actions: [] };
  return {
    _state: state,
    async accessibilityTrusted() { return false; },
    async accessibilityElements() {
      state.traversals++;
      return [
        { id: `tree-${state.traversals}-name`, role: "AXTextField", title: "First name", actions: [], childCount: 0 },
        { id: `tree-${state.traversals}-state`, role: "AXPopUpButton", title: "State", actions: ["AXShowMenu"], childCount: 0 },
        { id: `tree-${state.traversals}-submit`, role: "AXButton", title: "Submit", actions: ["AXPress"], childCount: 0 },
      ];
    },
    async selectAccessibilityOption(id, option) { state.selections.push({ id, option }); },
    async setAccessibilityValue(id, value) { state.values.push({ id, value }); },
    async performAccessibilityAction(id, action) { state.actions.push({ id, action }); },
  };
}

describe("accessibility macro steps", () => {
  test("reports accessibility trust without treating a denied permission as an execution error", async () => {
    const service = makeService();
    const results = await runMacro(service, [{ action: "accessibilityTrusted" }]);

    expect(results).toEqual([
      { step: 0, action: "accessibilityTrusted", ok: true, detail: "false" },
    ]);
  });

  test("resolves selectors against a fresh tree immediately before acting", async () => {
    const service = makeService();
    const results = await runMacro(service, [
      {
        action: "selectAccessibilityOption",
        target: { role: "AXPopUpButton", titleIncludes: "state" },
        option: "Alabama",
      },
      {
        action: "setAccessibilityValue",
        target: { role: "AXTextField", titleIncludes: "first" },
        value: "Mia",
      },
      {
        action: "performAccessibilityAction",
        target: { role: "AXButton", titleIncludes: "submit" },
        accessibilityAction: "AXPress",
      },
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(service._state.selections).toEqual([{ id: "tree-1-state", option: "Alabama" }]);
    expect(service._state.values).toEqual([{ id: "tree-2-name", value: "Mia" }]);
    expect(service._state.actions).toEqual([{ id: "tree-3-submit", action: "AXPress" }]);
  });

  test("can inspect once and then use an explicit ID from that traversal", async () => {
    const service = makeService();
    const results = await runMacro(service, [
      { action: "accessibilityElements", interactiveOnly: true },
      {
        action: "setAccessibilityValue",
        target: { id: "tree-1-name" },
        value: "Mia",
      },
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(service._state.traversals).toBe(1);
    expect(service._state.values).toEqual([{ id: "tree-1-name", value: "Mia" }]);
  });

  test("stops on an unmatched selector unless continueOnError is enabled", async () => {
    const service = makeService();
    const steps = [
      {
        action: "setAccessibilityValue",
        target: { role: "AXTextField", titleIncludes: "missing" },
        value: "Mia",
      },
      { action: "accessibilityElements" },
    ];

    const stopped = await runMacro(service, steps);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ ok: false, action: "setAccessibilityValue" });

    const continued = await runMacro(makeService(), steps, { continueOnError: true });
    expect(continued).toHaveLength(2);
    expect(continued.map((result) => result.ok)).toEqual([false, true]);
  });
});
