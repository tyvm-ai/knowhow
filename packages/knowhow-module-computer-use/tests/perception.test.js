const {
  findBoxes,
  findColorBlobs,
  findShapes,
  connectedComponents,
  edgeMap,
  parseHex,
  findRegions,
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

describe("findRegions (segment / element detection)", () => {
  test("foreground mode finds a small button on an empty background", () => {
    // A large empty background with one small distinct-colored button that does
    // NOT span a full-width edge row (which findBoxes would miss).
    const f = blankFrame(400, 400, [100, 130, 40]);
    fillRect(f, 170, 300, 60, 24, [120, 200, 120]); // "Start Game" button
    const roots = findRegions(f, { mode: "foreground", minSize: 15, minPixels: 100 });
    // Should find the button as one of the boxes.
    const flat = [];
    const walk = (ns) => ns.forEach((n) => (flat.push(n), walk(n.children)));
    walk(roots);
    const btn = flat.find(
      (b) =>
        Math.abs(b.bounds.x - 170) <= 6 &&
        Math.abs(b.bounds.y - 300) <= 6 &&
        Math.abs(b.bounds.width - 60) <= 8
    );
    expect(btn).toBeDefined();
  });

  test("panels mode groups foreground content over a shared background surface", () => {
    // A page background, with a distinct horizontal "toolbar" surface strip
    // near the top that carries several small text-like content blobs (a score
    // readout). Panels mode should treat the strip as a background SURFACE and
    // group the content blobs sitting on it, nesting them inside the surface.
    const f = blankFrame(400, 400, [30, 30, 30]); // page bg
    // Toolbar surface: a wide flat strip of a distinct flat color (kept below
    // full frame width so it isn't filtered by the maxSizeFrac guard).
    fillRect(f, 10, 10, 360, 60, [70, 70, 90]);
    // Content blobs on the strip (SCORE / ROUND / HITS readout), same-ish text
    // color, spaced apart so they cluster as separate small elements.
    fillRect(f, 20, 28, 24, 20, [230, 230, 230]);
    fillRect(f, 80, 28, 24, 20, [230, 230, 230]);
    fillRect(f, 140, 28, 24, 20, [230, 230, 230]);
    const roots = findRegions(f, {
      mode: "panels",
      colorBits: 3,
      minSize: 12,
      minPixels: 40,
      clusterGap: 3,
      bgAreaFrac: 0.01,
    });
    const flat = [];
    const walk = (ns) => ns.forEach((n) => (flat.push(n), walk(n.children)));
    walk(roots);
    // The toolbar surface (~400x60) should be detected as a box.
    const surface = flat.find(
      (b) => b.bounds.width >= 300 && b.bounds.width <= 380 && Math.abs(b.bounds.height - 60) <= 12
    );
    expect(surface).toBeDefined();
    // And at least one small content element sitting on it should be captured.
    const content = flat.find(
      (b) => b.bounds.width < 120 && b.bounds.height < 40 && b.bounds.y >= 10 && b.bounds.y <= 70
    );
    expect(content).toBeDefined();
  });

  test("colors mode nests a differently-colored inner element by containment", () => {
    const f = blankFrame(400, 400, [100, 130, 40]);
    // A card (one color) with an inner button (another color) inside it.
    fillRect(f, 100, 100, 200, 160, [60, 60, 60]); // card fill
    fillRect(f, 150, 200, 100, 40, [20, 200, 200]); // inner button (distinct)
    const roots = findRegions(f, { mode: "colors", colorBits: 3, minSize: 20, minPixels: 100 });
    const flat = [];
    const walk = (ns) => ns.forEach((n) => (flat.push(n), walk(n.children)));
    walk(roots);
    // Card box (~200x160) should be found, and it should contain a nested child.
    const card = flat.find(
      (b) => Math.abs(b.bounds.width - 200) <= 12 && Math.abs(b.bounds.height - 160) <= 12
    );
    expect(card).toBeDefined();
    expect(card.children.length).toBeGreaterThanOrEqual(1);
  });
});
