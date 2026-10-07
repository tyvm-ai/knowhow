/**
 * Full-window parse ("hints" / "map" default): every actionable element gets
 * a label, numbered in reading order, and big numbers ("row forty eight")
 * parse. Also: "double click" after "mouse over X" acts on X, not the gaze.
 */
import { rankCandidates, AXElement, HINT_DENSITY, sortReadingOrder } from "../src/smartSelector";
import { parseUtterance } from "../src/grammar";
import { collectVoiceCommands, BUILTIN_VOICE_COMMANDS } from "../src/voiceCommands";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { HINTS_PACK, getHintDensity } from "../src/packs/hints";
import { notePointerPlaced, clearPlacedPointer, doubleClickTarget } from "../src/pointerMemory";

const cmds = collectVoiceCommands({ builtins: [...BUILTIN_VOICE_COMMANDS, ...GAZE_MOUSE_PACK, ...HINTS_PACK] });
const match = (u: string) => {
  const r = parseUtterance(u, cmds) as any;
  return r.kind === "match" ? r.result : undefined;
};

const el = (id: string, role: string, x: number, y: number, title: string, w = 300, h = 30): AXElement =>
  ({ id, role, title, bounds: { x, y, width: w, height: h }, enabled: true } as AXElement);

describe("full-window parse", () => {
  it("is the default density and labels far more than a handful", () => {
    expect(HINT_DENSITY.all.full).toBe(true);
    expect(HINT_DENSITY.all.labels).toBeGreaterThanOrEqual(200);
    if (!process.env.KNOWHOW_HINT_DENSITY) expect(getHintDensity()).toBe("all");
  });

  it("labels all 60 inbox rows (no per-name cap) in top-to-bottom order", () => {
    // 60 identical-looking email rows + a few toolbar buttons, gaze at the top.
    const rows = Array.from({ length: 60 }, (_, i) => el(`r${i}`, "AXRow", 100, 200 + i * 40, i % 2 ? "Newsletter" : "Newsletter"));
    const buttons = [el("b1", "AXButton", 100, 100, "Compose", 80), el("b2", "AXButton", 300, 100, "Archive", 80)];
    const ranked = rankCandidates({
      gaze: { x: 150, y: 120 },
      errorRadius: { x: 200, y: 260 },
      elements: [...rows.reverse(), ...buttons],
      wholeWindow: true,
      fullParse: true,
      maxCandidates: HINT_DENSITY.all.labels,
    });
    const rowCands = ranked.filter((c) => c.roleName === "row");
    expect(rowCands).toHaveLength(60);
    expect(rowCands[0].element.id).toBe("r0");
    expect(rowCands[47].label).toBe("row 48");
    expect(rowCands[47].element.id).toBe("r47");
    expect(ranked.find((c) => c.element.id === "b1")?.label).toBe("button 1");
  });

  it("sortReadingOrder groups a row of cards left to right", () => {
    const cards = [el("c", "AXLink", 500, 102, "C"), el("a", "AXLink", 100, 100, "A"), el("d", "AXLink", 100, 300, "D"), el("b", "AXLink", 300, 98, "B")];
    expect(sortReadingOrder(cards, (c) => c.bounds!).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("hint grammar", () => {
  it("'map' is a synonym for hints", () => {
    expect(match("map")?.command.name).toBe("hints.show");
    expect(match("show map")?.command.name).toBe("hints.show");
    expect(match("hide map")?.command.name).toBe("hints.hide");
    expect(match("map all")?.command.name).toBe("hints.show-all");
    expect(match("hints")?.command.name).toBe("hints.show");
  });

  it("parses two-digit label numbers and row/image roles", () => {
    const m = match("click button forty eight");
    expect(m?.command.name).toBe("hints.click-hint");
    expect(m?.slots.hint).toEqual({ roleName: "button", index: 48 });
    expect(match("click button 48")?.slots.hint).toEqual({ roleName: "button", index: 48 });
    expect(match("mouse over row 23")?.slots.hint).toEqual({ roleName: "row", index: 23 });
    expect(match("click image twelve")?.slots.hint).toEqual({ roleName: "image", index: 12 });
  });
});

describe("double click after mouse over", () => {
  afterEach(() => clearPlacedPointer());

  it("targets the placed pointer even when gaze has moved far away", () => {
    notePointerPlaced({ x: 100, y: 100 });
    expect(doubleClickTarget({ gaze: { x: 1500, y: 900 }, target: () => ({ x: 1500, y: 900 }) })).toEqual({ x: 100, y: 100 });
  });

  it("targets the placed pointer even while gaze-follow is running", () => {
    notePointerPlaced({ x: 100, y: 100 });
    expect(
      doubleClickTarget({ gazeFollow: { isRunning: () => true }, target: () => ({ x: 1500, y: 900 }) }),
    ).toEqual({ x: 100, y: 100 });
  });

  it("falls back to gaze without a recent placement", () => {
    expect(doubleClickTarget({ target: () => ({ x: 1500, y: 900 }) })).toEqual({ x: 1500, y: 900 });
  });

  it("'double click' command double-clicks at the placed pointer, not the gaze", async () => {
    notePointerPlaced({ x: 100, y: 100 });
    const m = match("double click");
    expect(m).toBeDefined();
    const mouse = { moveMouse: jest.fn(), clickAt: jest.fn(), doubleClickAt: jest.fn() };
    await m.command.run({
      slots: m.slots ?? {},
      gaze: { x: 1500, y: 900 },
      target: () => ({ x: 1500, y: 900 }),
      mouse,
      log: () => undefined,
    } as any);
    expect(mouse.doubleClickAt).toHaveBeenCalledWith(100, 100);
  });
});
