const {
  ComputerService,
  scaleFindRegionsOptions,
} = require("../ts_build/ComputerService");

describe("ComputerService scaled capture", () => {
  test("forwards native region and scale while preserving desktop mapping", async () => {
    const service = new ComputerService();
    const driver = {
      screenshot: jest.fn().mockResolvedValue({
        __raw: true,
        width: 25,
        height: 20,
        data: Buffer.alloc(25 * 20 * 4),
      }),
      getDisplays: jest.fn().mockResolvedValue([
        { id: 7, primary: true, bounds: { x: 0, y: 0, width: 400, height: 300 } },
      ]),
    };
    service.getDriver = jest.fn().mockResolvedValue(driver);
    const region = { x: 100, y: 50, width: 100, height: 80 };

    const frame = await service.grabRawFrame(7, region, 0.25);

    expect(driver.screenshot).toHaveBeenCalledWith({
      displayId: 7,
      region,
      captureScale: 0.25,
    });
    expect(frame.desktop).toEqual(region);
    expect(frame.scaleX).toBe(0.25);
    expect(frame.scaleY).toBe(0.25);
    expect(service.imgRegionToDesktop(
      { x: 5, y: 4, width: 10, height: 8 },
      frame.desktop,
      frame.scaleX,
      frame.scaleY
    )).toEqual({ x: 120, y: 66, width: 40, height: 32 });
  });

  test("scales linear and area thresholds but leaves desktop options intact", () => {
    const scaled = scaleFindRegionsOptions(
      { minSize: 20, minPixels: 160, dilate: 8, clusterGap: 12, colorBits: 3 },
      0.25,
      0.5
    );
    expect(scaled).toMatchObject({
      minSize: 5,
      minPixels: 20,
      dilate: 2,
      clusterGap: 3,
      colorBits: 3,
    });
  });

  test.each([0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid capture scale %s",
    async (scale) => {
      const service = new ComputerService();
      await expect(service.grabRawFrame(undefined, undefined, scale)).rejects.toThrow(
        /Capture scale/
      );
    }
  );
});

describe("ComputerService batch pixel sampling", () => {
  test("samples desktop points from one frame with offset and scale mapping", async () => {
    const service = new ComputerService();
    const data = Buffer.from([
      0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff, 0x77, 0x88, 0x99, 0xff,
      0xaa, 0xbb, 0xcc, 0xff, 0xdd, 0xee, 0xff, 0xff, 0x01, 0x02, 0x03, 0xff,
    ]);
    service.grabRawFrame = jest.fn().mockResolvedValue({
      raw: { __raw: true, width: 3, height: 2, data },
      desktop: { x: 100, y: 50, width: 6, height: 4 },
      scaleX: 0.5,
      scaleY: 0.5,
    });

    await expect(service.pixelColors([
      { x: 100, y: 50 },
      { x: 102, y: 50 },
      { x: 104, y: 52 },
      { x: -100, y: 999 },
    ])).resolves.toEqual([
      "#112233",
      "#445566",
      "#010203",
      "#AABBCC",
    ]);
    expect(service.grabRawFrame).toHaveBeenCalledTimes(1);
  });

  test("does not capture a frame for an empty point list", async () => {
    const service = new ComputerService();
    service.grabRawFrame = jest.fn();

    await expect(service.pixelColors([])).resolves.toEqual([]);
    expect(service.grabRawFrame).not.toHaveBeenCalled();
  });
});

describe("ComputerService accessibility selection", () => {
  test("does nothing when the requested option is already selected", async () => {
    const service = new ComputerService();
    service.accessibilityElements = jest.fn().mockResolvedValue([
      {
        id: "country-select",
        role: "AXPopUpButton",
        value: "United States",
        actions: ["AXPress"],
        childCount: 0,
        bounds: { x: 100, y: 100, width: 200, height: 30 },
      },
    ]);
    service.setAccessibilityValue = jest.fn();
    service.performAccessibilityAction = jest.fn();
    service.moveMouse = jest.fn();
    service.click = jest.fn();
    service.typeText = jest.fn();

    await service.selectAccessibilityOption("country-select", " United States ");

    expect(service.accessibilityElements).toHaveBeenCalledTimes(1);
    expect(service.setAccessibilityValue).not.toHaveBeenCalled();
    expect(service.performAccessibilityAction).not.toHaveBeenCalled();
    expect(service.click).not.toHaveBeenCalled();
    expect(service.typeText).not.toHaveBeenCalled();
  });
});

describe("ComputerService OCR", () => {
  test("recognizes full-display tiles concurrently and forwards the recognition level", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const service = new ComputerService();
      service.getDisplays = jest.fn().mockResolvedValue([
        {
          id: 5,
          bounds: { x: 0, y: 0, width: 3840, height: 2160 },
          primary: true,
          scaleFactor: 1,
        },
      ]);
      service.grabRawFrame = jest.fn().mockResolvedValue({
        raw: { __raw: true, width: 1, height: 1, data: Buffer.alloc(4) },
        desktop: { x: 0, y: 0, width: 3840, height: 2160 },
        scaleX: 1,
        scaleY: 1,
      });
      let active = 0;
      let peak = 0;
      service.ocrTile = jest.fn().mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return [];
      });

      await service.readText({ displayId: 5, recognitionLevel: "fast" });

      expect(service.ocrTile).toHaveBeenCalledTimes(2);
      expect(service.ocrTile.mock.calls.map((call) => call[3])).toEqual([
        "fast",
        "fast",
      ]);
      expect(peak).toBe(2);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });
});
