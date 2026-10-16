import { normaliseTranscript, tokenise } from "../src/grammar/normalise";
import { getSlotMatcher } from "../src/grammar/slots";
import { nameFuzzyScore } from "../src/hints/ranking";
import { resolveHintRef } from "../src/hints/refs";
import { SelectorState } from "../src/hints/selectorState";
import { Candidate } from "../src/hints/types";
import { PointerMemory, TargetResolver } from "../src/services";

function phrase(text: string) {
  const toks = tokenise(normaliseTranscript(text));
  // tokens after the verb ("click …" / "mouse over …")
  const start = toks[0] === "mouse" ? 2 : 1;
  return getSlotMatcher("hintphrase")!.match(toks, start);
}

function cand(label: string, title: string, roleName = "text", roleIndex = 1): Candidate {
  return { element: { id: label, role: "VXText", title, actions: [], bounds: { x: 0, y: 0, width: 10, height: 10 } }, score: 1, label, roleName, roleIndex };
}

describe("hint phrases", () => {
  test("whisper 'hands' means hints", () => {
    expect(normaliseTranscript("Show hands.")).toBe("hints");
    expect(normaliseTranscript("hand mode")).toBe("hint mode");
    expect(normaliseTranscript("mouseover Theo")).toBe("mouse over theo");
  });

  test("multi-word on-screen phrases", () => {
    expect(phrase("mouse over Bitcoin Magazine.")?.value).toEqual({ name: "bitcoin magazine" });
    expect(phrase("click steal credentials")?.value).toEqual({ name: "steal credentials" });
    expect(phrase("click text 3")?.value).toEqual({ roleName: "text", index: 3 });
    expect(phrase("click that")).toBeUndefined();
    expect(phrase("click the button below thank you")).toBeUndefined();
  });

  test("name matching is case-insensitive and tolerant", () => {
    expect(nameFuzzyScore(["bitcoin", "magazine"], "Bitcoin Magazine")).toBe(1);
    expect(nameFuzzyScore(["t3", "gg"], "t3.gg")).toBe(1);
    expect(nameFuzzyScore(["thea"], "Theo")).toBeGreaterThan(0.5);
    const cands = [cand("input 1", "", "input"), cand("text 1", "Theo")];
    expect(resolveHintRef({ name: "theo" }, cands)?.label).toBe("text 1");
    expect(resolveHintRef({ name: "reachovers" }, cands)).toBeUndefined();
  });

  test("labels resolve against what was on screen at speech onset", () => {
    const selector = new SelectorState();
    const a = { candidates: [cand("text 1", "Old")], timestamp: Date.now() - 1000, selectedIndex: -1, ttlMs: 60000 };
    const b = { candidates: [cand("text 1", "New")], timestamp: Date.now(), selectedIndex: -1, ttlMs: 60000 };
    selector.setHintState(a);
    selector.setHintState(b);
    expect(selector.getHintStateAt(Date.now() - 500)?.candidates[0].element.title).toBe("Old");
    expect(selector.getHintStateAt(Date.now())?.candidates[0].element.title).toBe("New");
    selector.clearHintState();
  });

  test("plain click uses the pointer a hint just placed while gaze is near it", async () => {
    const pointer = new PointerMemory();
    const targets = new TargetResolver({ pointer });
    const ctx = (gaze?: { x: number; y: number }) => ({ gaze, target: () => gaze });
    const click = async (gaze: { x: number; y: number }) => (await targets.resolve(ctx(gaze), "click"))?.point;
    expect(await click({ x: 500, y: 500 })).toEqual({ x: 500, y: 500 });
    pointer.notePlaced({ x: 520, y: 480 });
    expect(await click({ x: 600, y: 600 })).toEqual({ x: 520, y: 480 });
    expect(await click({ x: 2000, y: 600 })).toEqual({ x: 2000, y: 600 });
  });
});
