const {
  resolveWindowRelativeRegion,
  isWindowRelativeRegion,
} = require("../ts_build/regions");

const anchored = {
  version: 1,
  region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
  anchor: {
    coordinateSpace: "window-normalized",
    window: { app: "Google Chrome", titleIncludes: "Form Master" },
  },
};

describe("window-relative regions", () => {
  test("scales and translates normalized coordinates from active window bounds", () => {
    expect(isWindowRelativeRegion(anchored)).toBe(true);
    expect(resolveWindowRelativeRegion(anchored, {
      app: "Google Chrome",
      title: "Form Master Benchmark",
      bounds: { x: -1000, y: 50, width: 800, height: 600 },
    })).toEqual({ x: -920, y: 170, width: 400, height: 240 });
  });

  test("fails closed when the active app or title does not match", () => {
    expect(() => resolveWindowRelativeRegion(anchored, {
      app: "Safari",
      title: "Form Master Benchmark",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })).toThrow(/does not match/);
  });

  test("supports fixed pixel offsets inside a moving window", () => {
    const pixelRegion = {
      ...anchored,
      region: { x: 20, y: 40, width: 300, height: 200 },
      anchor: { coordinateSpace: "window-pixels", window: { app: "Google Chrome" } },
    };
    expect(resolveWindowRelativeRegion(pixelRegion, {
      app: "Google Chrome",
      title: "Any tab",
      bounds: { x: 100, y: 200, width: 1000, height: 700 },
    })).toEqual({ x: 120, y: 240, width: 300, height: 200 });
  });
});
