const sharp = require("sharp");
const {
  computerUseScreenshot,
  computerUseScreenshotRegion,
  computerUseScreenshotWindow,
  computerUseScreenshotWindowTiles,
} = require("../ts_build/tools");

describe("computerUseScreenshot", () => {
  test("forwards tool scale as captureScale with display and region", async () => {
    const jpeg = await sharp({
      create: {
        width: 25,
        height: 20,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).jpeg().toBuffer();
    const service = {
      screenshot: jest.fn().mockResolvedValue(jpeg),
      screenSize: jest.fn().mockResolvedValue({ width: 400, height: 300 }),
    };
    const tools = { getContext: () => ({ ComputerUse: service }) };
    const region = { x: 100, y: 50, width: 100, height: 80 };

    const result = await computerUseScreenshot.call(
      tools,
      7,
      region,
      0.25,
      false,
      undefined,
      undefined
    );

    expect(service.screenshot).toHaveBeenCalledWith({
      displayId: 7,
      region,
      captureScale: 0.25,
    });
    expect(JSON.parse(result[0].text)).toMatchObject({
      regionX: 100,
      regionY: 50,
      desktopWidth: 100,
      desktopHeight: 80,
      imageWidth: 25,
      imageHeight: 20,
      scaleX: 0.25,
      scaleY: 0.25,
    });
  });

  test("returns an actionable capture error instead of undefined", async () => {
    const service = {
      screenshot: jest.fn().mockRejectedValue(new Error("region is outside capture domain")),
    };
    const tools = { getContext: () => ({ ComputerUse: service }) };

    const result = await computerUseScreenshot.call(
      tools,
      9,
      { x: 5000, y: 10, width: 200, height: 100 },
      0.5,
      false,
      undefined,
      undefined
    );

    expect(result).toMatch(/Capture failed for display 9/);
    expect(result).toMatch(/region is outside capture domain/);
    expect(result).toMatch(/computerUseGetDisplays/);
  });

  test("captures aiming regions at one-to-one desktop scale", async () => {
    const jpeg = await sharp({
      create: {
        width: 100,
        height: 80,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).jpeg().toBuffer();
    const service = {
      screenshot: jest.fn().mockResolvedValue(jpeg),
      getDisplays: jest.fn().mockResolvedValue([{ id: 4, bounds: { x: 0, y: 0, width: 400, height: 300 } }]),
    };
    const tools = { getContext: () => ({ ComputerUse: service }) };

    const result = await computerUseScreenshotRegion.call(
      tools,
      20,
      30,
      100,
      80,
      4,
      false
    );

    expect(service.screenshot).toHaveBeenCalledWith({
      displayId: 4,
      region: { x: 20, y: 30, width: 100, height: 80 },
      captureScale: 1,
      scale: 1,
    });
    expect(JSON.parse(result[0].text)).toMatchObject({
      regionX: 20, regionY: 30, imageWidth: 100, imageHeight: 80,
      scaleX: 1, scaleY: 1,
    });
  });

  test("captures and identifies one exact focused window", async () => {
    const bounds = { x: 20, y: 30, width: 100, height: 80 };
    const jpeg = await sharp({ create: { width: 100, height: 80, channels: 3,
      background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    const service = {
      listWindows: jest.fn().mockResolvedValue([{ id: 42, title: "Trade", app: "Chrome", bounds }]),
      focusWindowById: jest.fn().mockResolvedValue(true),
      getActiveWindow: jest.fn().mockResolvedValue({ id: 42, title: "Trade", app: "Chrome", bounds }),
      getDisplays: jest.fn().mockResolvedValue([{ id: 4, bounds: { x: 0, y: 0, width: 400, height: 300 } }]),
      screenshot: jest.fn().mockResolvedValue(jpeg),
    };
    const result = await computerUseScreenshotWindow.call(
      { getContext: () => ({ ComputerUse: service }) }, 42, false
    );
    expect(JSON.parse(result[0].text)).toMatchObject({ windowId: 42, windowBounds: bounds,
      windowTitle: "Trade", application: "Chrome", imageWidth: 100, imageHeight: 80 });
  });

  test("captures a verified window as non-overlapping native tiles", async () => {
    const bounds = { x: 20, y: 30, width: 100, height: 80 };
    const jpeg = await sharp({ create: { width: 50, height: 40, channels: 3,
      background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    const service = {
      listWindows: jest.fn().mockResolvedValue([{ id: 42, title: "Trade", app: "Chrome", bounds }]),
      focusWindowById: jest.fn().mockResolvedValue(true),
      getActiveWindow: jest.fn().mockResolvedValue({ id: 42, title: "Trade", app: "Chrome", bounds }),
      getDisplays: jest.fn().mockResolvedValue([{ id: 4, bounds: { x: 0, y: 0, width: 400, height: 300 } }]),
      screenshot: jest.fn().mockResolvedValue(jpeg),
    };
    const result = await computerUseScreenshotWindowTiles.call(
      { getContext: () => ({ ComputerUse: service }) }, 42, 2, 2
    );
    const metadata = JSON.parse(result[0].text);
    expect(metadata).toMatchObject({ windowId: 42, displayId: 4, columns: 2, rows: 2, tileCount: 4 });
    expect(metadata.tiles.map(t => t.windowRelativeBounds)).toEqual([
      { x: 0, y: 0, width: 50, height: 40 }, { x: 50, y: 0, width: 50, height: 40 },
      { x: 0, y: 40, width: 50, height: 40 }, { x: 50, y: 40, width: 50, height: 40 },
    ]);
    expect(service.screenshot).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(5);
  });
});
