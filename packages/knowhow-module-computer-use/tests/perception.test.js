const {
  findBoxes,
  findColorBlobs,
  findShapes,
  connectedComponents,
  edgeMap,
  parseHex,
} = require("../ts_build/perception");

/** Build a blank RGBA frame filled with a background color. */
function blankFrame(w, h, bg = [255, 255, 255]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function fillRect(frame, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= frame.width || yy >= frame.height) continue;
      const i = (yy * frame.width + xx) * 4;
      frame.data[i] = color[0];
      frame.data[i + 1] = color[1];
      frame.data[i + 2] = color[2];
      frame.data[i + 3] = 255;
    }
  }
}

/** Draw a hollow rectangle border (for box/edge detection). */
function strokeRect(frame, x, y, w, h, color, thickness = 2) {
  fillRect(frame, x, y, w, thickness, color); // top
  fillRect(frame, x, y + h - thickness, w, thickness, color); // bottom
  fillRect(frame, x, y, thickness, h, color); // left
  fillRect(frame, x + w - thickness, y, thickness, h, color); // right
}

describe("perception primitives", () => {
  test("parseHex parses #RRGGBB", () => {
    expect(parseHex("#FF8800")).toEqual({ r: 255, g: 136, b: 0 });
    expect(() => parseHex("nope")).toThrow();
  });

  test("findColorBlobs locates a solid colored square center", () => {
    const f = blankFrame(200, 200);
    fillRect(f, 60, 50, 40, 40, [200, 30, 30]);
    const blobs = findColorBlobs(f, { color: "#C81E1E", tolerance: 20, minPixels: 50 });
    expect(blobs.length).toBe(1);
    const c = blobs[0].center;
    expect(c.x).toBeGreaterThanOrEqual(75);
    expect(c.x).toBeLessThanOrEqual(85);
    expect(c.y).toBeGreaterThanOrEqual(65);
    expect(c.y).toBeLessThanOrEqual(75);
  });

  test("connectedComponents separates two disjoint blobs", () => {
    const w = 100,
      h = 100;
    const mask = new Uint8Array(w * h);
    const set = (x, y) => (mask[y * w + x] = 1);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) set(x, y);
    for (let y = 60; y < 75; y++) for (let x = 60; x < 75; x++) set(x, y);
    const comps = connectedComponents(mask, w, h, 5);
    expect(comps.length).toBe(2);
  });

  test("findShapes classifies a horizontal line", () => {
    const f = blankFrame(200, 100);
    fillRect(f, 20, 50, 120, 3, [0, 0, 0]);
    const lines = findShapes(f, {
      kind: "line-h",
      color: "#000000",
      tolerance: 40,
      length: 40,
      thickness: 6,
    });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0].kind).toBe("line-h");
  });

  test("findShapes classifies a filled square", () => {
    const f = blankFrame(200, 200);
    fillRect(f, 40, 40, 50, 50, [20, 120, 220]);
    const squares = findShapes(f, {
      kind: "square",
      color: "#1478DC",
      tolerance: 30,
      minSize: 20,
    });
    expect(squares.length).toBeGreaterThanOrEqual(1);
    expect(squares[0].kind).toBe("square");
  });

  test("findBoxes detects a button nested inside a modal (hierarchy)", () => {
    const f = blankFrame(400, 400, [240, 240, 240]);
    // Outer modal border.
    strokeRect(f, 40, 40, 300, 300, [20, 20, 20], 3);
    // Inner button border.
    strokeRect(f, 120, 250, 120, 50, [20, 20, 20], 3);
    const roots = findBoxes(f, { minSize: 30, minEdgeScore: 0.5 });
    expect(roots.length).toBeGreaterThanOrEqual(1);
    // The largest root should contain a nested child (the button).
    const withChildren = roots.find((r) => r.children.length > 0);
    expect(withChildren).toBeDefined();
    const child = withChildren.children[0];
    // Child should be within the parent bounds.
    expect(child.bounds.x).toBeGreaterThanOrEqual(withChildren.bounds.x - 5);
    expect(child.depth).toBe(1);
  });
});
