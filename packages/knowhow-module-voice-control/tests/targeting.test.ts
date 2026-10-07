/** TargetResolver: the policy table, one test group per action. */
import { PointerMemory } from "../src/services/pointer";
import type { Clock } from "../src/services/clock";
import { POLICIES, TargetResolver, centerOf } from "../src/targeting/resolver";
import type { TargetAction } from "../src/targeting/resolver";

function setup() {
  let t = 1000;
  const clock = { now: () => t } as unknown as Clock;
  const pointer = new PointerMemory(clock);
  const targets = new TargetResolver({ pointer });
  const gazePoint = { x: 1500, y: 900 };
  const ctx = (opts: { gaze?: { x: number; y: number }; follow?: boolean } = {}) => {
    const gaze = "gaze" in opts ? opts.gaze : gazePoint;
    return {
      gaze,
      gazeFollow: opts.follow ? { isRunning: () => true } : undefined,
      target: () => gaze,
    };
  };
  return { pointer, targets, ctx, advance: (ms: number) => (t += ms) };
}

describe("POLICIES table", () => {
  it("has one entry per action with today's numbers", () => {
    expect(Object.keys(POLICIES).sort()).toEqual(["click", "doubleClick", "rightClick", "scroll", "type"]);
    expect(POLICIES.click).toMatchObject({ maxPointerAgeMs: 30000, requireGazeAgreement: true, gazeAgreementPx: 450, allowFollow: true });
    expect(POLICIES.rightClick).toEqual(POLICIES.click);
    expect(POLICIES.doubleClick).toMatchObject({ maxPointerAgeMs: 30000, requireGazeAgreement: false, followOverridesPointer: false });
    expect(POLICIES.type.maxPointerAgeMs).toBe(0);
    expect(POLICIES.scroll.maxPointerAgeMs).toBe(0);
  });
});

describe.each<TargetAction>(["click", "rightClick"])("%s policy", (action) => {
  it("uses the gaze point without a placed pointer", async () => {
    const { targets, ctx } = setup();
    expect(await targets.resolve(ctx(), action)).toMatchObject({ point: { x: 1500, y: 900 }, source: "gaze" });
  });

  it("uses the placed pointer while the gaze is within 450px of it", async () => {
    const { targets, ctx, pointer } = setup();
    pointer.notePlaced({ x: 520, y: 480 });
    const t = await targets.resolve(ctx({ gaze: { x: 600, y: 600 } }), action);
    expect(t).toMatchObject({ point: { x: 520, y: 480 }, source: "pointer", ageMs: 0 });
  });

  it("ignores the placed pointer when the gaze has moved far away", async () => {
    const { targets, ctx, pointer } = setup();
    pointer.notePlaced({ x: 520, y: 480 });
    expect((await targets.resolve(ctx({ gaze: { x: 2000, y: 600 } }), action))?.point).toEqual({ x: 2000, y: 600 });
  });

  it("ignores a placement older than 30s", async () => {
    const { targets, ctx, pointer, advance } = setup();
    pointer.notePlaced({ x: 520, y: 480 });
    advance(30001);
    expect((await targets.resolve(ctx({ gaze: { x: 520, y: 480 } }), action))?.source).toBe("gaze");
  });

  it("gaze-follow beats the placed pointer", async () => {
    const { targets, ctx, pointer } = setup();
    pointer.notePlaced({ x: 520, y: 480 });
    expect(await targets.resolve(ctx({ gaze: { x: 530, y: 490 }, follow: true }), action)).toMatchObject({
      point: { x: 530, y: 490 },
      source: "follow",
    });
  });
});

describe("doubleClick policy", () => {
  it("acts at the placed pointer however far the gaze has moved", async () => {
    const { targets, ctx, pointer } = setup();
    pointer.notePlaced({ x: 100, y: 100 });
    expect((await targets.resolve(ctx(), "doubleClick"))?.point).toEqual({ x: 100, y: 100 });
  });

  it("…and even while gaze-follow is running", async () => {
    const { targets, ctx, pointer } = setup();
    pointer.notePlaced({ x: 100, y: 100 });
    expect((await targets.resolve(ctx({ follow: true }), "doubleClick"))?.source).toBe("pointer");
  });

  it("expires after 30s and falls back to follow, then gaze", async () => {
    const { targets, ctx, pointer, advance } = setup();
    pointer.notePlaced({ x: 100, y: 100 });
    advance(30001);
    expect((await targets.resolve(ctx({ follow: true }), "doubleClick"))?.source).toBe("follow");
    expect((await targets.resolve(ctx(), "doubleClick"))?.source).toBe("gaze");
  });

  it("has no target without any point", async () => {
    const { targets, ctx } = setup();
    expect(await targets.resolve(ctx({ gaze: undefined }), "doubleClick")).toBeUndefined();
  });
});

describe("type / scroll policies", () => {
  it.each<TargetAction>(["type", "scroll"])("%s ignores a placed pointer and acts at the gaze", async (action) => {
    const { targets, ctx, pointer } = setup();
    pointer.notePlaced({ x: 100, y: 100 });
    expect(await targets.resolve(ctx(), action)).toMatchObject({ point: { x: 1500, y: 900 }, source: "gaze" });
  });

  it.each<TargetAction>(["type", "scroll"])("%s uses the gaze-follow position when it is running", async (action) => {
    const { targets, ctx } = setup();
    expect((await targets.resolve(ctx({ follow: true }), action))?.source).toBe("follow");
  });
});

describe("hints", () => {
  it("`that` makes any action use the double-click rules and carries the hovered element + app", async () => {
    const { targets, ctx, pointer } = setup();
    const element = { id: "e", role: "AXRow", actions: [], bounds: { x: 0, y: 0, width: 10, height: 10 } } as any;
    pointer.notePlaced({ x: 5, y: 5 }, { element, score: 1, label: "row 1", roleName: "row", roleIndex: 1 }, "Notes");
    const t = await targets.resolve(ctx(), "click", { that: true });
    expect(t).toMatchObject({ point: { x: 5, y: 5 }, source: "pointer", app: "Notes" });
    expect(t?.element).toBe(element);
    // without `that`, the far-away gaze beats the placement and no element is attached
    expect((await targets.resolve(ctx(), "click"))?.source).toBe("gaze");
  });

  it("an explicit element resolves to its centre", async () => {
    const { targets, ctx } = setup();
    const element = { id: "e", role: "AXButton", actions: [], bounds: { x: 10, y: 20, width: 100, height: 40 } } as any;
    expect(centerOf(element)).toEqual({ x: 60, y: 40 });
    expect(await targets.resolve(ctx(), "click", { element })).toMatchObject({ point: { x: 60, y: 40 }, source: "element", element });
  });

  it("a ref resolves through the label lookup (source hint)", async () => {
    const { pointer } = setup();
    const element = { id: "e", role: "AXButton", actions: [], bounds: { x: 0, y: 0, width: 20, height: 20 } } as any;
    const targets = new TargetResolver({
      pointer,
      lookupRef: (ref) => (ref.name === "save" ? { element, score: 1, label: "button 1", roleName: "button", roleIndex: 1 } : undefined),
    });
    const t = await targets.resolve({ target: () => undefined }, "click", { ref: { name: "save" } });
    expect(t).toMatchObject({ point: { x: 10, y: 10 }, source: "hint" });
    expect(await targets.resolve({ target: () => undefined }, "click", { ref: { name: "nope" } })).toBeUndefined();
  });
});
