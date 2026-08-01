const { computerUseClickAt } = require("../ts_build/tools");

function makeHarness({ sameContext = false, displays, activeWindows } = {}) {
  const calls = [];
  let screenshots = 0;
  let clicked = false;
  const configuredDisplays = displays || [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true },
  ];
  const configuredWindows = activeWindows || {
    before: { title: "Chrome", bounds: { x: 100, y: 50, width: 1600, height: 900 } },
    after: { title: "Chrome", bounds: { x: 100, y: 50, width: 1600, height: 900 } },
  };
  const service = {
    async getDisplays() {
      return configuredDisplays;
    },
    async screenSize() {
      return { width: 1920, height: 1080 };
    },
    async getActiveWindow() {
      return clicked ? configuredWindows.after : configuredWindows.before;
    },
    async moveMouse(point) {
      calls.push(["move", point]);
    },
    async click(button) {
      calls.push(["click", button]);
      clicked = true;
    },
    async screenshot(options) {
      calls.push(["screenshot", options]);
      screenshots += 1;
      const marker = sameContext && screenshots > 1 ? 2 : screenshots;
      return Buffer.from([0xff, 0xd8, 0xff, marker]);
    },
  };
  const tools = { getContext: () => ({ ComputerUse: service }) };
  return { tools, calls };
}

describe("clickAt action-attached visual feedback", () => {
  test("returns bounded before/after images with absolute metadata", async () => {
    const { tools, calls } = makeHarness();
    const result = await computerUseClickAt.call(tools, 500, 400, "left", { delayMs: 0 });

    expect(result.map((part) => part.type)).toEqual([
      "text",
      "text",
      "image_url",
      "text",
      "image_url",
    ]);
    expect(JSON.parse(result[0].text)).toMatchObject({
      action: "clickAt",
      point: { x: 500, y: 400 },
      coordinateSpace: "absolute-desktop-pixels",
      before: { bounds: { x: 380, y: 280, width: 240, height: 240 }, scale: 1 },
      after: { bounds: { x: 100, y: 50, width: 1600, height: 900 }, scale: 0.25 },
    });
    expect(calls.map((call) => call[0])).toEqual([
      "move",
      "screenshot",
      "click",
      "screenshot",
    ]);
  });

  test("can omit an unchanged contextual after image", async () => {
    const { tools } = makeHarness({ sameContext: true });
    const result = await computerUseClickAt.call(tools, 500, 400, "left", {
      delayMs: 0,
      omitUnchanged: true,
    });
    expect(result.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(JSON.parse(result[0].text).after.omitted).toBe(true);
  });

  test("rejects malformed coordinates before moving or clicking", async () => {
    const { tools, calls } = makeHarness();
    await expect(computerUseClickAt.call(tools, undefined, 20)).rejects.toThrow(
      "finite lowercase `x` and `y`"
    );
    expect(calls).toEqual([]);
  });

  test("resolves the default context from the active window after clicking", async () => {
    const { tools } = makeHarness({
      activeWindows: {
        before: { title: "Chrome", bounds: { x: 100, y: 50, width: 1600, height: 900 } },
        after: { title: "Dialog", bounds: { x: 300, y: 200, width: 800, height: 600 } },
      },
    });

    const result = await computerUseClickAt.call(tools, 500, 400, "left", { delayMs: 0 });

    expect(JSON.parse(result[0].text).after.bounds).toEqual({
      x: 300,
      y: 200,
      width: 800,
      height: 600,
    });
  });

  test("captures a post-click active window on a different display", async () => {
    const { tools } = makeHarness({
      displays: [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true },
        { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, primary: false },
      ],
      activeWindows: {
        before: { title: "Chrome", bounds: { x: 100, y: 50, width: 1600, height: 900 } },
        after: { title: "Chrome", bounds: { x: 100, y: 50, width: 1600, height: 900 } },
      },
    });

    const result = await computerUseClickAt.call(tools, 2500, 400, "left", { delayMs: 0 });

    expect(JSON.parse(result[0].text).after.bounds).toEqual({
      x: 100,
      y: 50,
      width: 1600,
      height: 900,
    });
  });
});
