/**
 * Unit tests for snap.ts and resolveMonitor helpers.
 */

import { snapRect, resolveMonitor } from "../src/actions/types";
import { sortAndIndexMonitors, monitorForPoint } from "../src/actions/snap";
import type { MonitorInfo } from "../src/actions/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMonitor(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: Partial<MonitorInfo> = {},
): MonitorInfo {
  return {
    index: id,
    id,
    bounds: { x, y, width, height },
    primary: id === 1,
    ...opts,
  };
}

const mon1 = makeMonitor(1, 0, 0, 1920, 1080);
const mon2 = makeMonitor(2, 1920, 0, 1920, 1080);

// A monitor with a work area (subtracts 25px menu bar + 70px dock)
const mon1WA = makeMonitor(1, 0, 0, 1920, 1080, {
  workArea: { x: 0, y: 25, width: 1920, height: 985 },
});

// ─── snapRect ─────────────────────────────────────────────────────────────────

describe("snapRect", () => {
  describe("without workArea (uses bounds)", () => {
    test("left = left half", () => {
      const r = snapRect(mon1, "left");
      expect(r).toEqual({ x: 0, y: 0, width: 960, height: 1080 });
    });

    test("right = right half", () => {
      const r = snapRect(mon1, "right");
      expect(r).toEqual({ x: 960, y: 0, width: 960, height: 1080 });
    });

    test("top = top half", () => {
      const r = snapRect(mon1, "top");
      expect(r).toEqual({ x: 0, y: 0, width: 1920, height: 540 });
    });

    test("bottom = bottom half", () => {
      const r = snapRect(mon1, "bottom");
      expect(r).toEqual({ x: 0, y: 540, width: 1920, height: 540 });
    });

    test("full = entire bounds", () => {
      const r = snapRect(mon1, "full");
      expect(r).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    });

    test("top-left = top-left quarter", () => {
      const r = snapRect(mon1, "top-left");
      expect(r).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    });

    test("top-right = top-right quarter", () => {
      const r = snapRect(mon1, "top-right");
      expect(r).toEqual({ x: 960, y: 0, width: 960, height: 540 });
    });

    test("bottom-left = bottom-left quarter", () => {
      const r = snapRect(mon1, "bottom-left");
      expect(r).toEqual({ x: 0, y: 540, width: 960, height: 540 });
    });

    test("bottom-right = bottom-right quarter", () => {
      const r = snapRect(mon1, "bottom-right");
      expect(r).toEqual({ x: 960, y: 540, width: 960, height: 540 });
    });

    test("left-third", () => {
      const r = snapRect(mon1, "left-third");
      expect(r.x).toBe(0);
      expect(r.width).toBe(640);
      expect(r.height).toBe(1080);
    });

    test("center-third", () => {
      const r = snapRect(mon1, "center-third");
      expect(r.x).toBe(640);
      expect(r.width).toBe(640);
    });

    test("right-third", () => {
      const r = snapRect(mon1, "right-third");
      expect(r.x).toBe(1280);
      expect(r.width).toBe(640);
    });

    test("left-two-thirds", () => {
      const r = snapRect(mon1, "left-two-thirds");
      expect(r.x).toBe(0);
      expect(r.width).toBe(1280);
    });

    test("right-two-thirds", () => {
      const r = snapRect(mon1, "right-two-thirds");
      expect(r.x).toBe(640);
      expect(r.width).toBe(1280);
    });
  });

  describe("with workArea", () => {
    test("uses workArea instead of bounds", () => {
      const r = snapRect(mon1WA, "left");
      expect(r).toEqual({ x: 0, y: 25, width: 960, height: 985 });
    });

    test("full uses workArea", () => {
      const r = snapRect(mon1WA, "full");
      expect(r).toEqual({ x: 0, y: 25, width: 1920, height: 985 });
    });
  });

  describe("second monitor (non-zero origin)", () => {
    test("left on monitor 2", () => {
      const r = snapRect(mon2, "left");
      expect(r).toEqual({ x: 1920, y: 0, width: 960, height: 1080 });
    });

    test("right on monitor 2", () => {
      const r = snapRect(mon2, "right");
      expect(r).toEqual({ x: 2880, y: 0, width: 960, height: 1080 });
    });
  });
});

// ─── resolveMonitor ──────────────────────────────────────────────────────────

describe("resolveMonitor", () => {
  const monitors: MonitorInfo[] = [
    makeMonitor(1, 0, 0, 1920, 1080, { primary: true }),
    makeMonitor(2, 1920, 0, 1920, 1080, { primary: false }),
    makeMonitor(3, 3840, 0, 1440, 900, { primary: false }),
  ];

  test("undefined → returns current (or first)", () => {
    const result = resolveMonitor(undefined, monitors, monitors[1]);
    expect(result?.index).toBe(2);
  });

  test("number 1 → first monitor", () => {
    expect(resolveMonitor(1, monitors)?.index).toBe(1);
  });

  test("number 2 → second monitor", () => {
    expect(resolveMonitor(2, monitors)?.index).toBe(2);
  });

  test('"one" → first monitor', () => {
    expect(resolveMonitor("one", monitors)?.index).toBe(1);
  });

  test('"two" → second monitor', () => {
    expect(resolveMonitor("two", monitors)?.index).toBe(2);
  });

  test('"three" → third monitor', () => {
    expect(resolveMonitor("three", monitors)?.index).toBe(3);
  });

  test('"left" → leftmost monitor (index 1)', () => {
    expect(resolveMonitor("left", monitors)?.index).toBe(1);
  });

  test('"right" → rightmost monitor (index 3)', () => {
    expect(resolveMonitor("right", monitors)?.index).toBe(3);
  });

  test('"primary" → primary monitor', () => {
    expect(resolveMonitor("primary", monitors)?.primary).toBe(true);
  });

  test('"this" → current monitor', () => {
    expect(resolveMonitor("this", monitors, monitors[1])?.index).toBe(2);
  });

  test('"other" → not current monitor', () => {
    const result = resolveMonitor("other", monitors, monitors[0]);
    expect(result?.index).not.toBe(1);
  });

  test("numeric string → works", () => {
    expect(resolveMonitor("2", monitors)?.index).toBe(2);
  });

  test("not found → undefined", () => {
    expect(resolveMonitor(99, monitors)).toBeUndefined();
  });

  test("empty monitors → undefined", () => {
    expect(resolveMonitor("left", [])).toBeUndefined();
  });
});

// ─── sortAndIndexMonitors ─────────────────────────────────────────────────────

describe("sortAndIndexMonitors", () => {
  test("sorts left-to-right and assigns 1-based index", () => {
    const raw: MonitorInfo[] = [
      makeMonitor(0, 1920, 0, 1920, 1080),
      makeMonitor(0, 3840, 0, 1440, 900),
      makeMonitor(0, 0, 0, 1920, 1080),
    ];
    const sorted = sortAndIndexMonitors(raw);
    expect(sorted[0].bounds.x).toBe(0);
    expect(sorted[0].index).toBe(1);
    expect(sorted[1].bounds.x).toBe(1920);
    expect(sorted[1].index).toBe(2);
    expect(sorted[2].bounds.x).toBe(3840);
    expect(sorted[2].index).toBe(3);
  });

  test("does not mutate input", () => {
    const raw: MonitorInfo[] = [
      makeMonitor(0, 1920, 0, 1920, 1080),
      makeMonitor(0, 0, 0, 1920, 1080),
    ];
    const copy = [...raw];
    sortAndIndexMonitors(raw);
    expect(raw[0].bounds.x).toBe(copy[0].bounds.x);
    expect(raw[1].bounds.x).toBe(copy[1].bounds.x);
  });
});

// ─── monitorForPoint ─────────────────────────────────────────────────────────

describe("monitorForPoint", () => {
  const monitors: MonitorInfo[] = [
    makeMonitor(1, 0, 0, 1920, 1080),
    makeMonitor(2, 1920, 0, 1920, 1080),
  ];

  test("point inside monitor 1", () => {
    expect(monitorForPoint({ x: 100, y: 100 }, monitors)?.index).toBe(1);
  });

  test("point inside monitor 2", () => {
    expect(monitorForPoint({ x: 2000, y: 100 }, monitors)?.index).toBe(2);
  });

  test("point at exact boundary of monitor 2", () => {
    expect(monitorForPoint({ x: 1920, y: 0 }, monitors)?.index).toBe(2);
  });

  test("point in gap returns nearest monitor", () => {
    // Point at x=1910 is inside mon1 (0..1919)
    expect(monitorForPoint({ x: 1910, y: 0 }, monitors)?.index).toBe(1);
  });

  test("empty monitors → undefined", () => {
    expect(monitorForPoint({ x: 0, y: 0 }, [])).toBeUndefined();
  });
});
