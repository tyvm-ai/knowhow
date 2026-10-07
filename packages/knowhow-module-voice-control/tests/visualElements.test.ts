/**
 * Screenshot ("visual") hint provider: OCR + box fusion, ranking integration,
 * and the auto fallback in collectCandidates when accessibility is empty.
 */
import {
  fuseVisualElements,
  segmentOcrLines,
  dedupeAgainstAX,
  invalidateVisualCache,
  OcrLineLike,
} from "../src/visualElements";
import {
  rankCandidates,
  collectCandidates,
  invalidateAXCache,
  ComputerUseAdapter,
  AXElement,
} from "../src/smartSelector";
import { parseUtterance } from "../src/grammar";
import { HINTS_PACK } from "../src/packs/hints";

const word = (text: string, x: number, y = 100, w = text.length * 8, h = 14) => ({ text, bounds: { x, y, width: w, height: h } });
const line = (words: ReturnType<typeof word>[]): OcrLineLike => {
  const x = Math.min(...words.map((w) => w.bounds.x));
  const r = Math.max(...words.map((w) => w.bounds.x + w.bounds.width));
  return { text: words.map((w) => w.text).join(" "), confidence: 0.9, bounds: { x, y: words[0].bounds.y, width: r - x, height: 14 }, words };
};

describe("segmentOcrLines", () => {
  it("splits a menu bar into items but keeps phrases together", () => {
    const menu = line([word("Insert", 0), word("Format", 70), word("Tools", 140)]);
    const phrase = line([word("Normal", 300, 200), word("text", 352, 200)]);
    const segs = segmentOcrLines([menu, phrase]);
    expect(segs.map((s) => s.text)).toEqual(["Insert", "Format", "Tools", "Normal text"]);
  });

  it("drops OCR noise without letters", () => {
    const noise: OcrLineLike = { text: "• • •", confidence: 0.9, bounds: { x: 0, y: 0, width: 30, height: 10 } };
    expect(segmentOcrLines([noise])).toEqual([]);
  });
});

describe("fuseVisualElements", () => {
  const save = line([word("Save", 110, 108)]); // text 110..142 x 108..122
  const buttonBox = { x: 96, y: 98, width: 60, height: 34 };
  const emailLabel = line([word("Email", 100, 200)]);
  const emailBox = { x: 100, y: 222, width: 300, height: 36 };
  const icon = { x: 500, y: 100, width: 24, height: 24 };
  const panel = { x: 0, y: 0, width: 1000, height: 800 };

  const els = fuseVisualElements([save, emailLabel], [buttonBox, emailBox, icon, panel], {
    area: { x: 0, y: 0, width: 1000, height: 800 },
  });
  const byRole = (r: string) => els.filter((e) => e.role === r);

  it("turns padded text-on-box into a button with the box bounds", () => {
    expect(byRole("VXButton")).toHaveLength(1);
    expect(byRole("VXButton")[0]).toMatchObject({ title: "Save", bounds: buttonBox });
  });

  it("turns an empty wide box into an input titled by the label above", () => {
    expect(byRole("VXInput")[0]).toMatchObject({ title: "Email", bounds: emailBox });
  });

  it("keeps unboxed text and small empty boxes as text and icons, ignoring panels", () => {
    expect(byRole("VXText").map((e) => e.title)).toEqual(["Email"]);
    expect(byRole("VXIcon")[0].bounds).toEqual(icon);
    expect(els.some((e) => e.bounds?.width === 1000)).toBe(false);
  });

  it("visual elements have no AX actions (activation clicks the centre)", () => {
    expect(els.every((e) => e.actions.length === 0)).toBe(true);
  });
});

describe("inline words", () => {
  const para = line([word("used", 0, 300, 32), word("by", 36, 300, 16), word("glaucoma", 56, 300, 64), word("patients", 124, 300, 64)]);
  const els = fuseVisualElements([para], []);

  it("are not offered as numbered hints without a spoken name", () => {
    const c = rankCandidates({ gaze: { x: 90, y: 306 }, errorRadius: { x: 200, y: 260 }, elements: els });
    expect(c.every((x) => x.element.role !== "VXWord")).toBe(true);
  });

  it("let a spoken name target just that word", () => {
    const c = rankCandidates({ gaze: { x: 20, y: 306 }, errorRadius: { x: 200, y: 260 }, elements: els, query: ["glaucoma"] });
    expect(c[0].element.role).toBe("VXWord");
    const b = c[0].element.bounds!;
    expect(b.x + b.width / 2).toBeGreaterThan(56);
    expect(b.x + b.width / 2).toBeLessThan(120);
  });
});

describe("rankCandidates labels", () => {
  it("labels visual roles as button/input/text/icon", () => {
    const els = fuseVisualElements(
      [line([word("Save", 110, 108)]), line([word("Help", 300, 108)])],
      [{ x: 96, y: 98, width: 60, height: 34 }, { x: 400, y: 100, width: 24, height: 24 }],
    );
    const labels = rankCandidates({ gaze: { x: 200, y: 110 }, errorRadius: { x: 200, y: 260 }, elements: els }).map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["button 1", "text 1", "icon 1"]));
  });
});

describe("dedupeAgainstAX", () => {
  it("drops visual elements that sit on an AX control", () => {
    const ax: AXElement[] = [{ id: "a", role: "AXButton", bounds: { x: 90, y: 90, width: 80, height: 50 }, actions: ["AXPress"] }];
    const vis: AXElement[] = [
      { id: "vis:0", role: "VXButton", bounds: { x: 96, y: 98, width: 60, height: 34 }, actions: [] },
      { id: "vis:1", role: "VXText", bounds: { x: 400, y: 98, width: 60, height: 20 }, actions: [] },
    ];
    expect(dedupeAgainstAX(vis, ax, new Set(["AXButton"])).map((e) => e.id)).toEqual(["vis:1"]);
  });
});

describe("collectCandidates screenshot fallback", () => {
  function adapter(ax: AXElement[]): ComputerUseAdapter & { ocrCalls: number } {
    const a: any = {
      ocrCalls: 0,
      accessibilityElements: async () => ax,
      performAccessibilityAction: async () => undefined,
      showOverlay: async () => undefined,
      clearOverlay: async () => undefined,
      moveMouse: async () => undefined,
      click: async () => undefined,
      typeText: async () => undefined,
      hotkey: async () => undefined,
      getActiveWindow: async () => ({ app: "Google Chrome", bounds: { x: 0, y: 0, width: 1200, height: 900 } }),
      readText: async () => {
        a.ocrCalls++;
        return [line([word("Start", 210, 208), word("Game", 254, 208)])];
      },
      findRegions: async () => [{ bounds: { x: 196, y: 198, width: 110, height: 34 } }],
    };
    return a;
  }
  beforeEach(() => {
    invalidateAXCache();
    invalidateVisualCache();
  });
  const log = () => undefined;

  it("adds screenshot hints when accessibility has nothing near gaze", async () => {
    const a = adapter([{ id: "w", role: "AXWindow", actions: [] }]);
    const c = await collectCandidates(a, { x: 250, y: 215 }, { x: 200, y: 260 }, "k1", { log });
    expect(a.ocrCalls).toBe(1);
    expect(c[0]).toMatchObject({ label: "button 1", displayName: "start game" });
  });

  it("skips screenshots when accessibility already has enough", async () => {
    const ax: AXElement[] = [0, 1, 2].map((i) => ({ id: `b${i}`, role: "AXButton", title: `B${i}`, bounds: { x: 200 + i * 60, y: 200, width: 50, height: 30 }, actions: ["AXPress"] }));
    const a = adapter(ax);
    const c = await collectCandidates(a, { x: 250, y: 215 }, { x: 200, y: 260 }, "k2", { log });
    expect(a.ocrCalls).toBe(0);
    expect(c).toHaveLength(3);
  });

  it("source: visual ignores accessibility entirely", async () => {
    const a = adapter([]);
    const c = await collectCandidates(a, { x: 250, y: 215 }, { x: 200, y: 260 }, "k3", { log, source: "visual" });
    expect(c.map((x) => x.element.role)).toEqual(["VXButton"]);
  });
});

describe("grammar for screenshot hints", () => {
  const parse = (t: string) => {
    const r = parseUtterance(t, HINTS_PACK);
    return r.kind === "match" ? { name: r.result.command.name, slots: r.result.slots } : undefined;
  };
  it("parses text/icon numbered hints and hover", () => {
    expect(parse("click text 3")).toEqual({ name: "hints.click-hint", slots: { hint: { roleName: "text", index: 3 } } });
    expect(parse("icon two")).toEqual({ name: "hints.bare-hint", slots: { hint: { roleName: "icon", index: 2 } } });
    expect(parse("hover button 2")?.name).toBe("hints.hover-hint");
    expect(parse("mouse to text 1")?.name).toBe("hints.hover-hint");
  });
  it("keeps 'type text …' as typing", () => {
    expect(parse("type text hello world")).toEqual({
      name: "hints.type-in",
      slots: { hint: { name: "text" }, text: "hello world" },
    });
  });
});
