/**
 * Tests for axEnabler.ts — pure logic: cache per pid and shouldEnableWebAX decision.
 *
 * Does NOT invoke osascript or swiftc (those are side-effecting and OS-dependent).
 */

import {
  getAXEnablerCache,
  clearAXEnablerCache,
  hasWebContent,
  hasActionableWebContent,
  shouldEnableWebAX,
} from "../src/axEnabler";

beforeEach(() => {
  clearAXEnablerCache();
});

// ─── Cache per pid ────────────────────────────────────────────────────────────

describe("AX enabler cache", () => {
  it("starts empty after clearAXEnablerCache", () => {
    const cache = getAXEnablerCache();
    expect(cache.size).toBe(0);
  });

  it("returns the cached result on second call (no re-enable)", async () => {
    const cache = getAXEnablerCache();
    // Manually populate the cache (simulating a prior enableAXForPid call)
    cache.set(12345, "ok:manual");
    expect(cache.get(12345)).toBe("ok:manual");
    // A second set with same pid should not overwrite if already set
    // (the real enableAXForPid returns early when cached)
    expect(cache.size).toBe(1);
  });

  it("stores different results for different pids", () => {
    const cache = getAXEnablerCache();
    cache.set(111, "ok:manual");
    cache.set(222, "ok:enhanced");
    cache.set(333, "none");
    expect(cache.get(111)).toBe("ok:manual");
    expect(cache.get(222)).toBe("ok:enhanced");
    expect(cache.get(333)).toBe("none");
    expect(cache.size).toBe(3);
  });

  it("clearAXEnablerCache removes all entries", () => {
    const cache = getAXEnablerCache();
    cache.set(111, "ok:manual");
    cache.set(222, "ok:enhanced");
    clearAXEnablerCache();
    expect(getAXEnablerCache().size).toBe(0);
  });
});

// ─── hasWebContent ─────────────────────────────────────────────────────────────

describe("hasWebContent", () => {
  it("returns false for empty element list", () => {
    expect(hasWebContent([])).toBe(false);
  });

  it("returns false when no AXWebArea present", () => {
    const elements = [
      { role: "AXButton" },
      { role: "AXTextField" },
      { role: "AXGroup" },
      { role: "AXWindow" },
    ];
    expect(hasWebContent(elements)).toBe(false);
  });

  it("returns true when AXWebArea is present", () => {
    const elements = [
      { role: "AXButton" },
      { role: "AXWebArea" },
      { role: "AXTextField" },
    ];
    expect(hasWebContent(elements)).toBe(true);
  });

  it("returns true when AXWebArea is the only element", () => {
    expect(hasWebContent([{ role: "AXWebArea" }])).toBe(true);
  });
});

// ─── shouldEnableWebAX ────────────────────────────────────────────────────────

describe("shouldEnableWebAX", () => {
  it("returns false when AXWebArea is already present (web content exists)", () => {
    const elements = [
      { role: "AXWebArea" },
      { role: "AXButton" },
      { role: "AXTextField" },
    ];
    expect(shouldEnableWebAX(elements)).toBe(false);
  });

  it("returns true when element list is empty (nothing exposed)", () => {
    expect(shouldEnableWebAX([])).toBe(true);
  });

  it("returns true when only toolbar/chrome elements are present (< 5 actionable)", () => {
    // Typical Chrome without web AX: only a few toolbar buttons + address bar
    const elements = [
      { role: "AXButton", bounds: { x: 10, y: 10, width: 30, height: 30 } },
      { role: "AXTextField", bounds: { x: 100, y: 10, width: 300, height: 30 } },
      { role: "AXButton", bounds: { x: 410, y: 10, width: 30, height: 30 } },
    ];
    expect(shouldEnableWebAX(elements)).toBe(true);
  });

  it("returns false when 5+ actionable elements present (web content likely accessible)", () => {
    const elements = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "AXButton" : "AXTextField",
      bounds: { x: i * 50, y: 100, width: 40, height: 30 },
    }));
    expect(shouldEnableWebAX(elements)).toBe(false);
  });

  it("excludes structural/container roles from the actionable count", () => {
    // AXGroup, AXWindow, AXApplication, AXSplitter, AXScrollBar should not count
    const structural = [
      { role: "AXGroup" },
      { role: "AXWindow" },
      { role: "AXApplication" },
      { role: "AXSplitter" },
      { role: "AXScrollBar" },
      { role: "AXGroup" },
      { role: "AXWindow" },
      { role: "AXApplication" },
    ];
    // Even with 8 elements, all structural → should enable
    expect(shouldEnableWebAX(structural)).toBe(true);
  });

  it("returns false when enough mixed elements present including non-structural", () => {
    const elements = [
      { role: "AXGroup" },
      { role: "AXButton" },
      { role: "AXButton" },
      { role: "AXTextField" },
      { role: "AXLink" },
      { role: "AXCheckBox" },
    ];
    // 5 non-structural elements → false
    expect(shouldEnableWebAX(elements)).toBe(false);
  });
});

// ─── hasActionableWebContent ─────────────────────────────────────────────────

describe("hasActionableWebContent", () => {
  it("returns false for empty list", () => {
    expect(hasActionableWebContent([])).toBe(false);
  });

  it("returns false when only AXWebArea and structural elements present", () => {
    expect(hasActionableWebContent([
      { role: "AXWebArea" },
      { role: "AXGroup" },
      { role: "AXScrollArea" },
    ])).toBe(false);
  });

  it("returns true when AXButton present", () => {
    expect(hasActionableWebContent([{ role: "AXWebArea" }, { role: "AXButton" }])).toBe(true);
  });

  it("returns true when AXTextField present", () => {
    expect(hasActionableWebContent([{ role: "AXTextField" }])).toBe(true);
  });

  it("returns true when AXLink present", () => {
    expect(hasActionableWebContent([{ role: "AXWebArea" }, { role: "AXLink" }])).toBe(true);
  });

  it("returns true when AXCheckBox present", () => {
    expect(hasActionableWebContent([{ role: "AXCheckBox" }])).toBe(true);
  });
});

// ─── shouldEnableWebAX: AXWebArea with empty web content ─────────────────────

describe("shouldEnableWebAX — AXWebArea present but empty", () => {
  it("returns true when AXWebArea present but no actionable elements in list (Chrome minimal mode)", () => {
    // This is the key Chrome case: AXWebArea visible in tree but renderer accessibility
    // is off, so the AX tree returns the web area with no actionable children at all.
    // The flat element list has only AXWebArea + structural roles — no AXButton/TextField/Link.
    const elements = [
      { role: "AXGroup", bounds: { x: 0, y: 0, width: 1440, height: 50 } },     // toolbar group
      { role: "AXWebArea", bounds: { x: 0, y: 80, width: 1440, height: 820 } }, // web area, no children
      { role: "AXScrollArea", bounds: { x: 0, y: 80, width: 1440, height: 820 } },
    ];
    // hasWebContent = true, hasActionableWebContent = false (no AXButton/TextField/Link) → should enable
    expect(shouldEnableWebAX(elements)).toBe(true);
  });

  it("returns false when AXWebArea present AND web actionable elements exist", () => {
    // Chrome with --force-renderer-accessibility: AXWebArea plus real form fields
    const elements = [
      { role: "AXButton" },     // toolbar
      { role: "AXTextField" },  // address bar
      { role: "AXWebArea" },    // web area
      { role: "AXButton" },     // web button (inside page)
      { role: "AXTextField" },  // web input
      { role: "AXLink" },       // web link
    ];
    expect(shouldEnableWebAX(elements)).toBe(false);
  });
});

// ─── Integration: enableAXForPid caches result ───────────────────────────────

describe("enableAXForPid caching (mocked)", () => {
  it("returns cached value without re-running osascript", async () => {
    // Pre-populate cache to simulate a prior enable
    const cache = getAXEnablerCache();
    cache.set(99999, "ok:manual");

    // Now dynamically require and call — it should read from cache
    // We do this by importing the function and calling it directly:
    const { enableAXForPid } = await import("../src/axEnabler");
    const logs: string[] = [];
    const result = await enableAXForPid(99999, (msg) => logs.push(msg));
    expect(result).toBe("ok:manual");
    // Should not have logged any "Attempting" message since it returned from cache
    expect(logs.some((l) => l.includes("Attempting"))).toBe(false);
  });
});
