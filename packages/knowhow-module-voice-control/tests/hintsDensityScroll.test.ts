/**
 * Screenshot-hint refinements from a live session on x.com (Twitter):
 * tile-split OCR fragments, text inside images, body copy crowding out
 * labels, duplicate icon+label hints, hint density commands, and the
 * scroll commands (which previously never scrolled).
 */
import {
  fuseVisualElements,
  mergeSplitLines,
  dropTinyText,
  OcrLineLike,
} from "../src/visualElements";
import { rankCandidates, AXElement, HINT_DENSITY } from "../src/smartSelector";
import { parseUtterance } from "../src/grammar";
import { HINTS_PACK } from "../src/packs/hints";
import { GAZE_MOUSE_PACK } from "../src/packs/gazeMouse";
import { DarwinPlatformActions } from "../src/actions/darwin";

const word = (text: string, x: number, y = 100, w = text.length * 8, h = 14) => ({ text, bounds: { x, y, width: w, height: h } });
const line = (words: ReturnType<typeof word>[], confidence = 1): OcrLineLike => {
  const x = Math.min(...words.map((w) => w.bounds.x));
  const r = Math.max(...words.map((w) => w.bounds.x + w.bounds.width));
  const h = words[0].bounds.height;
  return { text: words.map((w) => w.text).join(" "), confidence, bounds: { x, y: words[0].bounds.y, width: r - x, height: h }, words };
};

describe("mergeSplitLines", () => {
  it("re-joins a line cut at an OCR tile edge and drops the duplicated fragment", () => {
    // Tile edge at x=1176 (default readText grid) from a scan starting at 0.
    const left = line([word("Last", 1100, 100, 30), word("updated", 1135, 100, 40), word("hc", 1180, 100, 10)]);
    const right = line([word("hour", 1178, 100, 30), word("ago", 1212, 100, 24)]);
    const merged = mergeSplitLines([right, left], { x: 0, y: 0, width: 3000, height: 1600 });
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("Last updated hour ago");
  });

  it("does not merge separate rows or far-apart items", () => {
    const a = line([word("Home", 100, 100)]);
    const b = line([word("Explore", 100, 160)]);
    const c = line([word("Follow", 600, 100)]);
    expect(mergeSplitLines([a, b, c])).toHaveLength(3);
  });
});

describe("dropTinyText", () => {
  it("drops text much smaller than the page's UI text (text inside screenshots/videos)", () => {
    const ui = [0, 1, 2, 3].map((i) => line([word(`Label${i}`, 0, i * 40, 60, 20)]));
    const tiny = line([word("docker-compose.yml", 0, 300, 90, 7)]);
    const kept = dropTinyText([...ui, tiny]);
    expect(kept).toHaveLength(4);
    expect(kept.some((l) => l.text.includes("docker"))).toBe(false);
  });
});

describe("fuseVisualElements on a feed", () => {
  it("marks sentence lines as VXLongText and keeps short labels as VXText", () => {
    const els = fuseVisualElements(
      [
        line([word("We", 0, 0, 16), word("backdoored", 20, 0, 80), word("a", 104, 0, 8), word("7B", 116, 0, 16), word("open", 136, 0, 32), word("model", 172, 0, 40)]),
        line([word("Show", 0, 40, 32), word("more", 36, 40, 32)]),
      ],
      [],
    );
    expect(els.find((e) => e.title?.startsWith("We"))?.role).toBe("VXLongText");
    expect(els.find((e) => e.title === "Show more")?.role).toBe("VXText");
  });

  it("drops an icon that sits directly left of its label (one hint per nav item)", () => {
    const els = fuseVisualElements([line([word("Home", 60, 100, 50, 20)])], [{ x: 20, y: 98, width: 24, height: 24 }]);
    expect(els.filter((e) => e.role === "VXIcon")).toHaveLength(0);
    // A lone icon (no label beside it) is still a hint.
    const lone = fuseVisualElements([line([word("Home", 600, 100, 50, 20)])], [{ x: 20, y: 98, width: 24, height: 24 }]);
    expect(lone.filter((e) => e.role === "VXIcon")).toHaveLength(1);
  });
});

describe("rankCandidates for display", () => {
  const el = (id: string, role: string, x: number, y: number, title: string, w = 80, h = 20): AXElement => ({
    id, role, title, enabled: true, actions: [], bounds: { x, y, width: w, height: h },
  });

  it("caps body-copy lines so labels near the gaze get hints", () => {
    const paragraph = Array.from({ length: 10 }, (_, i) => el(`p${i}`, "VXLongText", 0, i * 22, `sentence number ${i} of the tweet body text`, 500));
    const labels = [el("show", "VXText", 0, 240, "Show more"), el("like", "VXText", 300, 280, "1.2K"), el("follow", "VXButton", 520, 100, "Follow")];
    const ranked = rankCandidates({ gaze: { x: 200, y: 100 }, errorRadius: { x: 200, y: 260 }, elements: [...paragraph, ...labels], maxCandidates: 15 });
    // At most 2 body lines (cap for a 15-label list) ahead of the labels;
    // the rest only fill leftover slots after every label.
    const first5 = ranked.slice(0, 5);
    expect(first5.filter((c) => c.element.role === "VXLongText").length).toBeLessThanOrEqual(2);
    for (const id of ["show", "like", "follow"]) expect(first5.some((c) => c.element.id === id)).toBe(true);
  });

  it("drops near-duplicate targets (label inside its own button)", () => {
    const btn = el("btn", "VXButton", 100, 100, "Follow", 90, 34);
    const txt = el("txt", "VXText", 110, 106, "Follow", 60, 20);
    const ranked = rankCandidates({ gaze: { x: 140, y: 115 }, errorRadius: { x: 200, y: 260 }, elements: [btn, txt] });
    expect(ranked).toHaveLength(1);
  });

  it("keeps inline words for spoken-name queries (no de-duplication)", () => {
    const ln = el("line", "VXLongText", 0, 0, "read about glaucoma treatment options today", 400);
    const w = el("w", "VXWord", 100, 0, "glaucoma", 70);
    const ranked = rankCandidates({ gaze: { x: 100, y: 10 }, errorRadius: { x: 200, y: 260 }, elements: [ln, w], query: ["glaucoma"] });
    expect(ranked[0].element.id).toBe("w");
  });
});

describe("hint density commands", () => {
  const parse = (t: string) => {
    const r = parseUtterance(t, [...HINTS_PACK, ...GAZE_MOUSE_PACK]);
    return r.kind === "match" ? r.result.command.name : r.kind;
  };
  it("parses more / fewer / normal / hide hints", () => {
    expect(parse("more hints")).toBe("hints.more");
    expect(parse("show more hints")).toBe("hints.more");
    expect(parse("fewer hints")).toBe("hints.fewer");
    expect(parse("less hints")).toBe("hints.fewer");
    expect(parse("show less hints")).toBe("hints.fewer");
    expect(parse("normal hints")).toBe("hints.normal");
    expect(parse("hide hints")).toBe("hints.hide");
    expect(parse("hints")).toBe("hints.show");
  });
  it("density levels grow in labels and scan size", () => {
    expect(HINT_DENSITY.few.labels).toBeLessThan(HINT_DENSITY.normal.labels);
    expect(HINT_DENSITY.normal.labels).toBeLessThan(HINT_DENSITY.more.labels);
    expect(HINT_DENSITY.more.scanFactor).toBeGreaterThan(HINT_DENSITY.normal.scanFactor);
    expect(HINT_DENSITY.all.wholeWindow).toBe(true);
  });
  it("parses mouse-over phrasings", () => {
    expect(parse("mouse over button 2")).toBe("hints.hover-hint");
    expect(parse("move mouse to chat")).toBe("hints.hover-hint");
    expect(parse("mouse here")).toBe("voice-control.gaze.mouse-here");
    expect(parse("move mouse here")).toBe("voice-control.gaze.mouse-here");
  });
});

describe("scroll", () => {
  it("moves the pointer to the gaze point, then sends plain (dx, dy) wheel deltas", async () => {
    const calls: string[] = [];
    const svc = {
      typeText: async () => undefined,
      pressKey: async () => undefined,
      getDisplays: async () => [],
      moveMouse: async (p: { x: number; y: number }) => { calls.push(`move ${p.x},${p.y}`); },
      scroll: async (dx: number, dy: number) => { calls.push(`scroll ${dx},${dy}`); },
    };
    const actions = new DarwinPlatformActions(svc);
    await actions.scroll(0, 5, { x: 500, y: 300 });
    // Native wheel deltas are positive-up, so "down 5" is sent as -5.
    expect(calls).toEqual(["move 500,300", "scroll 0,-5"]);
  });

  it("parses scroll phrasings", () => {
    const parse = (t: string) => {
      const r = parseUtterance(t, GAZE_MOUSE_PACK);
      return r.kind === "match" ? r.result.command.name : r.kind;
    };
    expect(parse("scroll down")).toBe("voice-control.gaze.scroll-down");
    expect(parse("slowly scroll down")).toBe("voice-control.gaze.slow-scroll-down");
    expect(parse("scroll down slowly")).toBe("voice-control.gaze.slow-scroll-down");
    expect(parse("keep scrolling")).toBe("voice-control.gaze.keep-scrolling");
    expect(parse("stop scrolling")).toBe("voice-control.gaze.stop-scrolling");
    expect(parse("faster")).toBe("voice-control.gaze.scroll-faster");
  });
});

describe("feed details found by the x.com recall eval", () => {
  it("splits @handles out of a line so each is its own hint", () => {
    const l = line([word("Eric", 0, 0, 32), word("ericjung", 36, 0, 64), word("5h", 108, 0, 16)]);
    l.text = "Eric @ericjung • 5h";
    const els = fuseVisualElements([l], []);
    const titles = els.filter((e) => e.role === "VXText").map((e) => e.title);
    expect(titles).toContain("Eric");
    expect(titles).toContain("ericjung");
  });

  it("finds '•••' overflow menus from the fine box pass", () => {
    const els = fuseVisualElements([line([word("Peter", 0, 0, 40)])], [{ x: 500, y: 6, width: 21, height: 7 }]);
    const more = els.find((e) => e.title === "more");
    expect(more?.role).toBe("VXIcon");
    expect(more!.bounds!.width).toBeGreaterThanOrEqual(20);
  });

  it("keeps an avatar next to a name (only glyph-sized icons merge into labels)", () => {
    const els = fuseVisualElements([line([word("Eric", 70, 10, 32, 20)])], [{ x: 10, y: 0, width: 50, height: 50 }]);
    // A 50px avatar is not merged into the name beside it.
    expect(els.some((e) => e.role === "VXIcon")).toBe(true);
  });
});
