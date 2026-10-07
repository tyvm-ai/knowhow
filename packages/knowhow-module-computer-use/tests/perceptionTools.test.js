const {
  computerUseReadText,
  computerUseGetPixelColors,
} = require("../ts_build/tools");
const { computerToolDefinitions } = require("../ts_build/tools/definitions");

describe("computer perception tools", () => {
  test("computerUseReadText forwards OCR options and returns concise absolute geometry", async () => {
    const service = {
      readText: jest.fn().mockResolvedValue([
        {
          text: "Canvas label",
          confidence: 0.92,
          bounds: { x: 410, y: 220, width: 90, height: 18 },
          center: { x: 455, y: 229 },
          ignored: "large payload",
        },
      ]),
    };
    const result = await computerUseReadText.call(
      { getContext: () => ({ ComputerUse: service }) },
      { x: 400, y: 200, width: 500, height: 300 },
      2,
      true,
      0.7,
      "fast"
    );

    expect(service.readText).toHaveBeenCalledWith({
      region: { x: 400, y: 200, width: 500, height: 300 },
      displayId: 2,
      activeWindow: true,
      minConfidence: 0.7,
      recognitionLevel: "fast",
    });
    expect(JSON.parse(result)).toEqual([
      {
        text: "Canvas label",
        confidence: 0.92,
        bounds: { x: 410, y: 220, width: 90, height: 18 },
        center: { x: 455, y: 229 },
      },
    ]);
  });

  test("computerUseGetPixelColors batches points in one frame", async () => {
    const points = [{ x: 10, y: 20 }, { x: 100, y: 200 }];
    const service = { pixelColors: jest.fn().mockResolvedValue(["#112233", "#AABBCC"]) };
    const result = await computerUseGetPixelColors.call(
      { getContext: () => ({ ComputerUse: service }) },
      points
    );
    expect(service.pixelColors).toHaveBeenCalledTimes(1);
    expect(service.pixelColors).toHaveBeenCalledWith(points);
    expect(JSON.parse(result)).toEqual(["#112233", "#AABBCC"]);
  });

  test("registers both perception tool definitions", () => {
    const names = computerToolDefinitions.map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining([
      "computerUseReadText",
      "computerUseGetPixelColors",
    ]));
  });
});
