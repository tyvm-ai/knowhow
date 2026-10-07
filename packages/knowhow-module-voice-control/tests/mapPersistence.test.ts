/**
 * The map stays up until "hide map", keeps stable numbers, and can be refreshed.
 */

import { mapChangeFraction, HINTS_PACK } from "../src/packs/hints";
import { showHintOverlay, buildHintOverlayPrimitives, type Candidate } from "../src/smartSelector";

function cand(i: number, name = `Item ${i}`, dy = 0): Candidate {
  return {
    element: { id: `e${i}`, role: "AXButton", title: name, bounds: { x: 10, y: i * 40 + dy, width: 200, height: 30 } } as any,
    score: 0.5,
    label: `button ${i + 1}`,
    roleName: "button",
    roleIndex: i + 1,
    displayName: name,
  };
}

describe("mapChangeFraction", () => {
  const base = Array.from({ length: 20 }, (_, i) => cand(i));
  it("is 0 for the same UI (and ignores a few px of jitter)", () => {
    expect(mapChangeFraction(base, base)).toBe(0);
    expect(mapChangeFraction(base, base.map((c, i) => cand(i, c.displayName, 3)))).toBe(0);
  });
  it("sees a scroll / different page as a big change", () => {
    expect(mapChangeFraction(base, base.map((c, i) => cand(i, c.displayName, 200)))).toBeGreaterThan(0.5);
    expect(mapChangeFraction(base, base.map((_, i) => cand(i, `Other ${i}`)))).toBe(1);
  });
  it("sees one new row as a small change", () => {
    const more = [...base, cand(20)];
    const f = mapChangeFraction(base, more);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(0.15);
  });
});

describe("showHintOverlay", () => {
  it("never auto-hides by default", async () => {
    jest.useFakeTimers();
    try {
      const adapter = { showOverlay: jest.fn(async () => undefined), clearOverlay: jest.fn(async () => undefined) };
      await showHintOverlay(adapter as any, [cand(0)]);
      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(adapter.clearOverlay).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("overlay colours", () => {
  it("gives a tag the same colour as its outline, and neighbours different colours", () => {
    const prims = buildHintOverlayPrimitives([cand(0), cand(1)], 9);
    const rects = prims.filter((p) => p.kind === "rect");
    const texts = prims.filter((p) => p.kind === "text");
    expect(String(rects[0].color).startsWith(String(texts[0].color))).toBe(true);
    expect(texts[0].color).not.toBe(texts[1].color);
  });
});

describe("refresh map command", () => {
  it("is registered with map/hints phrasings", () => {
    const cmd = HINTS_PACK.find((c) => c.name === "hints.refresh")!;
    expect(cmd).toBeDefined();
    expect(cmd.patterns).toEqual(expect.arrayContaining(["refresh map", "refresh hints", "update hints"]));
    // "map" variants come from the pack's synonyms, not copy-pasted patterns
    expect(cmd.aliases).toEqual(expect.arrayContaining(["update map", "reload map"]));
  });
});
