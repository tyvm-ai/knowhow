/**
 * Tests for the pure hints modules (src/hints/ranking, labels, refs, overlay)
 *
 * Run: npx jest tests/hints.ranking
 */

import { distanceToRect, gaussianLikelihood, rankCandidates, isAmbiguous, nameFuzzyScore } from "../src/hints/ranking";
import { parseHintRef, resolveHintRef } from "../src/hints/refs";
import { buildHintOverlayPrimitives } from "../src/hints/overlay";
import { AXElement, Rect, Candidate } from "../src/hints/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEl(
  id: string,
  role: string,
  bounds: Rect,
  title?: string,
  description?: string,
): AXElement {
  return { id, role, title, description, actions: ["AXPress"], bounds, enabled: true };
}

const ERROR_RADIUS = { x: 200, y: 260 };

// ─── distanceToRect ───────────────────────────────────────────────────────────

describe("distanceToRect", () => {
  const rect: Rect = { x: 100, y: 100, width: 100, height: 50 };

  it("returns 0 when point is inside", () => {
    expect(distanceToRect(150, 125, rect)).toBe(0);
  });

  it("returns 0 when point is on edge", () => {
    expect(distanceToRect(100, 125, rect)).toBe(0);
  });

  it("returns horizontal distance when outside left", () => {
    expect(distanceToRect(80, 125, rect)).toBeCloseTo(20);
  });

  it("returns vertical distance when outside top", () => {
    expect(distanceToRect(150, 70, rect)).toBeCloseTo(30);
  });

  it("returns diagonal distance when outside corner", () => {
    const d = distanceToRect(80, 70, rect);
    expect(d).toBeCloseTo(Math.sqrt(20 * 20 + 30 * 30));
  });
});

// ─── gaussianLikelihood ───────────────────────────────────────────────────────

describe("gaussianLikelihood", () => {
  const rect: Rect = { x: 200, y: 200, width: 100, height: 50 };

  it("returns 1.0 when point is inside rect", () => {
    expect(gaussianLikelihood(250, 225, rect, 200, 260)).toBe(1.0);
  });

  it("returns < 1 when outside", () => {
    const v = gaussianLikelihood(0, 0, rect, 200, 260);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it("decays with distance", () => {
    const close = gaussianLikelihood(280, 225, rect, 200, 260); // 20px outside
    const far = gaussianLikelihood(500, 225, rect, 200, 260);   // 200px outside
    expect(close).toBeGreaterThan(far);
  });
});

// ─── rankCandidates ───────────────────────────────────────────────────────────

describe("rankCandidates", () => {
  const button1 = makeEl("b1", "AXButton", { x: 200, y: 200, width: 80, height: 30 }, "Save");
  const button2 = makeEl("b2", "AXButton", { x: 700, y: 700, width: 80, height: 30 }, "Cancel");
  const input1 = makeEl("i1", "AXTextField", { x: 210, y: 250, width: 150, height: 30 }, "Email");
  const link1 = makeEl("l1", "AXLink", { x: 205, y: 190, width: 60, height: 20 }, "Privacy Policy");

  it("returns empty when no elements", () => {
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [],
    });
    expect(result).toHaveLength(0);
  });

  it("ranks nearby elements higher than far ones", () => {
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [button1, button2],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].element.id).toBe("b1");
  });

  it("assigns role-numbered labels", () => {
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [button1, input1, link1],
    });
    const labels = result.map((c) => c.label);
    expect(labels).toContain("button 1");
    expect(labels).toContain("input 1");
    expect(labels).toContain("link 1");
  });

  it("name query dominates when specified", () => {
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [button1, input1],
      query: ["email"],
    });
    // Email input should win because name matches
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].element.id).toBe("i1");
  });

  it("wholeWindow includes distant elements", () => {
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [button1, button2],
      wholeWindow: true,
    });
    expect(result.length).toBe(2);
  });

  it("filters disabled elements", () => {
    const disabledBtn = { ...button2, enabled: false };
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [button1, disabledBtn],
    });
    expect(result.every((c) => c.element.id !== disabledBtn.id)).toBe(true);
  });

  it("filters elements without bounds", () => {
    const noBounds: AXElement = { id: "nb", role: "AXButton", actions: ["AXPress"] };
    const result = rankCandidates({
      gaze: { x: 250, y: 225 },
      errorRadius: ERROR_RADIUS,
      elements: [button1, noBounds],
    });
    expect(result.every((c) => c.element.id !== "nb")).toBe(true);
  });
});

// ─── isAmbiguous ─────────────────────────────────────────────────────────────

describe("isAmbiguous", () => {
  it("returns false with 0 or 1 candidates", () => {
    expect(isAmbiguous([])).toBe(false);
    const single: Candidate = {
      element: makeEl("x", "AXButton", { x: 0, y: 0, width: 10, height: 10 }),
      score: 0.9,
      label: "button 1",
      roleName: "button",
      roleIndex: 1,
    };
    expect(isAmbiguous([single])).toBe(false);
  });

  it("returns true when scores are within 15%", () => {
    const a: Candidate = { element: makeEl("a", "AXButton", { x: 0, y: 0, width: 10, height: 10 }), score: 0.9, label: "button 1", roleName: "button", roleIndex: 1 };
    const b: Candidate = { element: makeEl("b", "AXButton", { x: 50, y: 50, width: 10, height: 10 }), score: 0.88, label: "button 2", roleName: "button", roleIndex: 2 };
    expect(isAmbiguous([a, b])).toBe(true);
  });

  it("returns false when scores differ by more than 15%", () => {
    const a: Candidate = { element: makeEl("a", "AXButton", { x: 0, y: 0, width: 10, height: 10 }), score: 0.9, label: "button 1", roleName: "button", roleIndex: 1 };
    const b: Candidate = { element: makeEl("b", "AXButton", { x: 50, y: 50, width: 10, height: 10 }), score: 0.5, label: "button 2", roleName: "button", roleIndex: 2 };
    expect(isAmbiguous([a, b])).toBe(false);
  });
});

// ─── parseHintRef ────────────────────────────────────────────────────────────

describe("parseHintRef", () => {
  it("parses 'button 2'", () => {
    const ref = parseHintRef("button 2");
    expect(ref.roleName).toBe("button");
    expect(ref.index).toBe(2);
    expect(ref.name).toBeUndefined();
  });

  it("parses 'input two'", () => {
    const ref = parseHintRef("input two");
    expect(ref.roleName).toBe("input");
    expect(ref.index).toBe(2);
  });

  it("parses 'link 3'", () => {
    const ref = parseHintRef("link 3");
    expect(ref.roleName).toBe("link");
    expect(ref.index).toBe(3);
  });

  it("parses 'save' (name only)", () => {
    const ref = parseHintRef("save");
    expect(ref.roleName).toBeUndefined();
    expect(ref.index).toBeUndefined();
    expect(ref.name).toBe("save");
  });

  it("parses 'check 1'", () => {
    const ref = parseHintRef("check 1");
    expect(ref.roleName).toBe("check");
    expect(ref.index).toBe(1);
  });

  it("parses 'checkbox' → check", () => {
    const ref = parseHintRef("checkbox 2");
    expect(ref.roleName).toBe("check");
    expect(ref.index).toBe(2);
  });

  it("parses bare number as index without role", () => {
    const ref = parseHintRef("input");
    expect(ref.roleName).toBe("input");
    expect(ref.index).toBeUndefined();
  });

  it("handles empty string", () => {
    const ref = parseHintRef("");
    expect(ref.roleName).toBeUndefined();
    expect(ref.index).toBeUndefined();
  });
});

// ─── resolveHintRef ───────────────────────────────────────────────────────────

describe("resolveHintRef", () => {
  const candidates: Candidate[] = [
    { element: makeEl("b1", "AXButton", { x: 0, y: 0, width: 10, height: 10 }, "Save"), score: 0.9, label: "button 1", roleName: "button", roleIndex: 1, displayName: "Save" },
    { element: makeEl("b2", "AXButton", { x: 100, y: 0, width: 10, height: 10 }, "Cancel"), score: 0.7, label: "button 2", roleName: "button", roleIndex: 2, displayName: "Cancel" },
    { element: makeEl("i1", "AXTextField", { x: 0, y: 50, width: 150, height: 30 }, "Email"), score: 0.8, label: "input 1", roleName: "input", roleIndex: 1, displayName: "Email" },
  ];

  it("resolves 'button 1' → first button", () => {
    const ref = parseHintRef("button 1");
    const c = resolveHintRef(ref, candidates);
    expect(c?.element.id).toBe("b1");
  });

  it("resolves 'button 2' → second button", () => {
    const ref = parseHintRef("button 2");
    const c = resolveHintRef(ref, candidates);
    expect(c?.element.id).toBe("b2");
  });

  it("resolves 'input 1' → input field", () => {
    const ref = parseHintRef("input 1");
    const c = resolveHintRef(ref, candidates);
    expect(c?.element.id).toBe("i1");
  });

  it("resolves 'save' by name", () => {
    const ref = parseHintRef("save");
    const c = resolveHintRef(ref, candidates);
    expect(c?.element.id).toBe("b1");
  });

  it("resolves 'cancel' by name", () => {
    const ref = parseHintRef("cancel");
    const c = resolveHintRef(ref, candidates);
    expect(c?.element.id).toBe("b2");
  });

  it("returns undefined for out-of-range index", () => {
    const ref = parseHintRef("button 9");
    const c = resolveHintRef(ref, candidates);
    expect(c).toBeUndefined();
  });
});

// ─── nameFuzzyScore ───────────────────────────────────────────────────────────

describe("nameFuzzyScore", () => {
  it("returns 1.0 for exact match", () => {
    expect(nameFuzzyScore(["save"], "Save")).toBe(1.0);
  });

  it("returns 0.5 for partial match", () => {
    expect(nameFuzzyScore(["save", "cancel"], "save")).toBe(0.5);
  });

  it("returns 0 for no match", () => {
    expect(nameFuzzyScore(["submit"], "cancel")).toBe(0);
  });

  it("returns 0 for empty query", () => {
    expect(nameFuzzyScore([], "save")).toBe(0);
  });
});

// ─── buildHintOverlayPrimitives ───────────────────────────────────────────────

describe("buildHintOverlayPrimitives", () => {
  it("generates rect and text primitives for each candidate", () => {
    const candidates: Candidate[] = [
      { element: makeEl("b1", "AXButton", { x: 10, y: 20, width: 80, height: 30 }, "Save"), score: 0.9, label: "button 1", roleName: "button", roleIndex: 1 },
    ];
    const prims = buildHintOverlayPrimitives(candidates);
    expect(prims.length).toBeGreaterThanOrEqual(2);
    expect(prims.some((p) => p.kind === "rect")).toBe(true);
    expect(prims.some((p) => p.kind === "text")).toBe(true);
  });

  it("limits to 9 candidates", () => {
    const many: Candidate[] = Array.from({ length: 15 }, (_, i) => ({
      element: makeEl(`b${i}`, "AXButton", { x: i * 10, y: 0, width: 10, height: 10 }),
      score: 0.5,
      label: `button ${i + 1}`,
      roleName: "button",
      roleIndex: i + 1,
    }));
    const prims = buildHintOverlayPrimitives(many);
    // At most 9 labels: rect + backing pill + text per element
    expect(prims.filter((p) => p.kind === "rect").length).toBe(9);
    expect(prims.filter((p) => p.kind === "text").length).toBe(9);
    expect(prims.length).toBeLessThanOrEqual(27);
  });

  it("respects a larger label budget and drops names when crowded", () => {
    const many: Candidate[] = Array.from({ length: 40 }, (_, i) => ({
      element: makeEl(`b${i}`, "AXButton", { x: (i % 8) * 120, y: Math.floor(i / 8) * 60, width: 100, height: 30 }, `Item ${i}`),
      score: 0.5,
      label: `button ${i + 1}`,
      roleName: "button",
      roleIndex: i + 1,
      displayName: `Item ${i}`,
    }));
    const prims = buildHintOverlayPrimitives(many, 30);
    const texts = prims.filter((p) => p.kind === "text");
    expect(texts.length).toBe(30);
    expect(texts.every((t) => !String(t.text).includes(":"))).toBe(true);
    // Tags draw after every outline so they're never hidden by one.
    const lastRect = prims.map((p) => p.kind).lastIndexOf("rect");
    const firstText = prims.findIndex((p) => p.kind === "text");
    expect(firstText).toBeGreaterThan(lastRect);
  });
});
