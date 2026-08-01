/**
 * Verifies the native Rust perception primitives are loadable and agree with the
 * pure-TS reference implementation on synthetic frames. Skips gracefully if the
 * native prebuild isn't available for this platform.
 */
const {
  hasNativeColorScan,
  hasNativeBoxes,
  nativeFindColorRegions,
  nativeFindBoxes,
} = require("../ts_build/nativePerception");
const { findColorBlobs } = require("../ts_build/perception");

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
      const i = (yy * frame.width + xx) * 4;
      frame.data[i] = color[0];
      frame.data[i + 1] = color[1];
      frame.data[i + 2] = color[2];
      frame.data[i + 3] = 255;
    }
  }
}

const describeNative = hasNativeColorScan() ? describe : describe.skip;

describeNative("native perception (Rust core)", () => {
  test("nativeFindColorRegions locates a solid square", () => {
    const f = blankFrame(200, 200);
    fillRect(f, 60, 50, 40, 40, [200, 30, 30]);
    const regions = nativeFindColorRegions(f.data, f.width, f.height, ["#C81E1E"], {
      tolerance: 20,
      sampleStep: 1,
      minPixels: 50,
    });
    expect(regions.length).toBe(1);
    const r = regions[0];
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    expect(cx).toBeGreaterThanOrEqual(75);
    expect(cx).toBeLessThanOrEqual(85);
    expect(cy).toBeGreaterThanOrEqual(65);
    expect(cy).toBeLessThanOrEqual(75);
  });

  test("native color regions agree with TS blob center", () => {
    const f = blankFrame(200, 200);
    fillRect(f, 60, 50, 40, 40, [200, 30, 30]);
    const native = nativeFindColorRegions(f.data, f.width, f.height, ["#C81E1E"], {
      tolerance: 20,
      sampleStep: 1,
      minPixels: 50,
    })[0];
    const ts = findColorBlobs(f, { color: "#C81E1E", tolerance: 20, minPixels: 50 })[0];
    const nativeCx = (native.minX + native.maxX) / 2;
    expect(Math.abs(nativeCx - ts.center.x)).toBeLessThanOrEqual(2);
  });

  test("nativeFindBoxes returns a nested hierarchy (parent index)", () => {
    if (!hasNativeBoxes()) return;
    const f = blankFrame(400, 400, [240, 240, 240]);
    const stroke = (x, y, w, h) => {
      fillRect(f, x, y, w, 3, [20, 20, 20]);
      fillRect(f, x, y + h - 3, w, 3, [20, 20, 20]);
      fillRect(f, x, y, 3, h, [20, 20, 20]);
      fillRect(f, x + w - 3, y, 3, h, [20, 20, 20]);
    };
    stroke(40, 40, 300, 300);
    stroke(120, 250, 120, 50);
    const boxes = nativeFindBoxes(f.data, f.width, f.height, {
      minSize: 30,
      minEdgeScore: 0.5,
    });
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    // At least one box should be nested (parent >= 0, depth 1).
    const nested = boxes.find((b) => b.parent >= 0);
    expect(nested).toBeDefined();
    expect(nested.depth).toBeGreaterThanOrEqual(1);
  });
});
