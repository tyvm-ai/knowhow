const {
  pointInShape,
  shapeBounds,
  toShape,
  isRegionShape,
  storedBounds,
  flattenSvgPath,
} = require("../ts_build/regionShape");

describe("regionShape", () => {
  test("legacy rect coerces to RectShape and hit-tests", () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    expect(isRegionShape(rect)).toBe(false);
    const shape = toShape(rect);
    expect(shape.type).toBe("rect");
    expect(pointInShape(shape, { x: 50, y: 40 })).toBe(true);
    expect(pointInShape(shape, { x: 200, y: 40 })).toBe(false);
    expect(storedBounds(rect)).toEqual(rect);
  });

  test("circle hit-test and bounds", () => {
    const c = { type: "circle", cx: 100, cy: 100, r: 40 };
    expect(pointInShape(c, { x: 100, y: 100 })).toBe(true);
    expect(pointInShape(c, { x: 130, y: 100 })).toBe(true);
    expect(pointInShape(c, { x: 150, y: 100 })).toBe(false); // outside radius
    expect(shapeBounds(c)).toEqual({ x: 60, y: 60, width: 80, height: 80 });
  });

  test("subtract: point in a hole is excluded even though inside base", () => {
    const s = {
      type: "subtract",
      base: { type: "rect", x: 0, y: 0, width: 200, height: 200 },
      holes: [{ type: "rect", x: 0, y: 0, width: 200, height: 40 }], // toolbar band
    };
    expect(pointInShape(s, { x: 100, y: 100 })).toBe(true); // in board
    expect(pointInShape(s, { x: 100, y: 20 })).toBe(false); // in the excluded band
    // Bounds are those of the base.
    expect(shapeBounds(s)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  test("union: point in any piece is inside (maze shape)", () => {
    const s = {
      type: "union",
      shapes: [
        { type: "rect", x: 0, y: 0, width: 50, height: 200 },
        { type: "rect", x: 0, y: 0, width: 200, height: 50 },
      ],
    };
    expect(pointInShape(s, { x: 25, y: 150 })).toBe(true); // left leg
    expect(pointInShape(s, { x: 150, y: 25 })).toBe(true); // top bar
    expect(pointInShape(s, { x: 150, y: 150 })).toBe(false); // empty corner
    expect(shapeBounds(s)).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  test("svgpath: flattens a triangle and hit-tests inside/outside", () => {
    const shape = { type: "svgpath", d: "M 0 0 L 100 0 L 50 100 Z" };
    const subs = flattenSvgPath(shape.d);
    expect(subs.length).toBe(1);
    expect(pointInShape(shape, { x: 50, y: 30 })).toBe(true); // inside triangle
    expect(pointInShape(shape, { x: 5, y: 90 })).toBe(false); // outside near base corner
    const b = shapeBounds(shape);
    expect(b.x).toBe(0);
    expect(b.width).toBe(100);
    expect(b.height).toBe(100);
  });

  test("svgpath: even-odd inner subpath becomes a hole", () => {
    // Outer square with an inner square subpath -> donut.
    const shape = {
      type: "svgpath",
      d: "M 0 0 L 100 0 L 100 100 L 0 100 Z M 30 30 L 70 30 L 70 70 L 30 70 Z",
      fillRule: "evenodd",
    };
    expect(pointInShape(shape, { x: 10, y: 50 })).toBe(true); // in outer ring
    expect(pointInShape(shape, { x: 50, y: 50 })).toBe(false); // in the hole
  });
});
