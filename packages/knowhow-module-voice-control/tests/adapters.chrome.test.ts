/**
 * Tests for adapters/chrome.ts (the Chrome DOM provider) — pure logic only.
 *
 * Does NOT invoke osascript (OS-dependent). Tests:
 *   - domElementsToAXElements: DOM → AXElement coordinate transform
 *   - findWebAreaFrame: extract viewport origin from AX elements
 *   - isAppleEventsJSDisabled: error string detection
 *   - Role mapping: input types → correct AX roles
 */

import {
  domElementsToAXElements,
  findWebAreaFrame,
  isAppleEventsJSDisabled,
  resetAppleEventsWarning,
  DOMElement,
} from "../src/adapters/chrome";

beforeEach(() => {
  resetAppleEventsWarning();
});

// ─── findWebAreaFrame ─────────────────────────────────────────────────────────

describe("findWebAreaFrame", () => {
  it("returns null for empty list", () => {
    expect(findWebAreaFrame([])).toBeNull();
  });

  it("returns null when no AXWebArea present", () => {
    expect(findWebAreaFrame([{ role: "AXButton" }, { role: "AXGroup" }])).toBeNull();
  });

  it("returns null when AXWebArea has no bounds", () => {
    expect(findWebAreaFrame([{ role: "AXWebArea" }])).toBeNull();
  });

  it("returns the AXWebArea bounds when present", () => {
    const elements = [
      { role: "AXGroup", bounds: { x: 0, y: 0, width: 1440, height: 50 } },
      { role: "AXWebArea", bounds: { x: 0, y: 80, width: 1440, height: 820 } },
    ];
    const frame = findWebAreaFrame(elements);
    expect(frame).toEqual({ x: 0, y: 80, width: 1440, height: 820 });
  });

  it("returns the FIRST AXWebArea when multiple exist", () => {
    const elements = [
      { role: "AXWebArea", bounds: { x: 0, y: 80, width: 1440, height: 820 } },
      { role: "AXWebArea", bounds: { x: 0, y: 200, width: 800, height: 600 } },
    ];
    const frame = findWebAreaFrame(elements);
    expect(frame).toEqual({ x: 0, y: 80, width: 1440, height: 820 });
  });
});

// ─── domElementsToAXElements — coordinate transform ──────────────────────────

describe("domElementsToAXElements — coordinate transform", () => {
  const viewport = { x: 0, y: 80, width: 1440, height: 820 };

  it("returns empty array for empty input", () => {
    expect(domElementsToAXElements([], viewport)).toHaveLength(0);
  });

  it("translates viewport-relative rect to screen coordinates", () => {
    const dom: DOMElement[] = [
      {
        tag: "input",
        type: "text",
        rect: { x: 100, y: 200, width: 300, height: 40 },
      },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els).toHaveLength(1);
    expect(els[0].bounds).toEqual({ x: 100, y: 280, width: 300, height: 40 }); // y = 80 + 200
  });

  it("adds viewport.x to element x coordinate", () => {
    const vp = { x: 50, y: 100, width: 1200, height: 700 };
    const dom: DOMElement[] = [
      { tag: "button", rect: { x: 200, y: 150, width: 100, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, vp);
    expect(els[0].bounds?.x).toBe(250); // 50 + 200
    expect(els[0].bounds?.y).toBe(250); // 100 + 150
  });

  it("filters out disabled elements", () => {
    const dom: DOMElement[] = [
      { tag: "button", disabled: true, rect: { x: 10, y: 10, width: 80, height: 36 } },
      { tag: "button", rect: { x: 100, y: 10, width: 80, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els).toHaveLength(1);
    expect(els[0].enabled).not.toBe(false);
  });
});

// ─── domElementsToAXElements — role mapping ──────────────────────────────────

describe("domElementsToAXElements — role mapping", () => {
  const viewport = { x: 0, y: 80, width: 1440, height: 820 };

  function makeEl(overrides: Partial<DOMElement>): DOMElement {
    return { tag: "input", rect: { x: 0, y: 0, width: 100, height: 36 }, ...overrides };
  }

  it("maps input[type=text] → AXTextField", () => {
    const els = domElementsToAXElements([makeEl({ tag: "input", type: "text" })], viewport);
    expect(els[0].role).toBe("AXTextField");
  });

  it("maps input[type=checkbox] → AXCheckBox", () => {
    const els = domElementsToAXElements([makeEl({ tag: "input", type: "checkbox" })], viewport);
    expect(els[0].role).toBe("AXCheckBox");
  });

  it("maps input[type=radio] → AXRadioButton", () => {
    const els = domElementsToAXElements([makeEl({ tag: "input", type: "radio" })], viewport);
    expect(els[0].role).toBe("AXRadioButton");
  });

  it("maps input[type=submit] → AXButton", () => {
    const els = domElementsToAXElements([makeEl({ tag: "input", type: "submit" })], viewport);
    expect(els[0].role).toBe("AXButton");
  });

  it("maps textarea → AXTextArea", () => {
    const els = domElementsToAXElements([makeEl({ tag: "textarea" })], viewport);
    expect(els[0].role).toBe("AXTextArea");
  });

  it("maps select → AXPopUpButton", () => {
    const els = domElementsToAXElements([makeEl({ tag: "select" })], viewport);
    expect(els[0].role).toBe("AXPopUpButton");
  });

  it("maps button → AXButton", () => {
    const els = domElementsToAXElements([makeEl({ tag: "button" })], viewport);
    expect(els[0].role).toBe("AXButton");
  });

  it("maps a → AXLink", () => {
    const els = domElementsToAXElements([makeEl({ tag: "a" })], viewport);
    expect(els[0].role).toBe("AXLink");
  });

  it("maps role=checkbox → AXCheckBox (ARIA override)", () => {
    const els = domElementsToAXElements([makeEl({ tag: "div", role: "checkbox" })], viewport);
    expect(els[0].role).toBe("AXCheckBox");
  });

  it("maps role=button → AXButton (ARIA override)", () => {
    const els = domElementsToAXElements([makeEl({ tag: "div", role: "button" })], viewport);
    expect(els[0].role).toBe("AXButton");
  });

  it("maps role=textbox → AXTextField", () => {
    const els = domElementsToAXElements([makeEl({ tag: "div", role: "textbox" })], viewport);
    expect(els[0].role).toBe("AXTextField");
  });
});

// ─── domElementsToAXElements — title/description ─────────────────────────────

describe("domElementsToAXElements — title/description population", () => {
  const viewport = { x: 0, y: 80, width: 1440, height: 820 };

  it("uses ariaLabel as title", () => {
    const dom: DOMElement[] = [
      { tag: "button", ariaLabel: "Close dialog", rect: { x: 0, y: 0, width: 40, height: 40 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].title).toBe("Close dialog");
  });

  it("uses placeholder as title when no ariaLabel", () => {
    const dom: DOMElement[] = [
      { tag: "input", placeholder: "Enter email", rect: { x: 0, y: 0, width: 200, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].title).toBe("Enter email");
  });

  it("uses text content as fallback", () => {
    const dom: DOMElement[] = [
      { tag: "button", text: "Submit", rect: { x: 0, y: 0, width: 80, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].title).toBe("Submit");
  });

  it("generates unique ids per element", () => {
    const dom: DOMElement[] = [
      { tag: "input", rect: { x: 0, y: 0, width: 100, height: 36 } },
      { tag: "input", rect: { x: 0, y: 50, width: 100, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].id).not.toBe(els[1].id);
  });
});

// ─── isAppleEventsJSDisabled ─────────────────────────────────────────────────

describe("isAppleEventsJSDisabled", () => {
  it("returns true for error code 12 in parentheses", () => {
    expect(isAppleEventsJSDisabled("execution error: (-12)")).toBe(true);
  });

  it("returns true for 'code 12' phrasing", () => {
    expect(isAppleEventsJSDisabled("AppleScript execution error: code 12")).toBe(true);
  });

  it("returns true for 'not enabled' phrasing", () => {
    expect(isAppleEventsJSDisabled("JavaScript from Apple Events is not enabled")).toBe(true);
  });

  it("returns true for 'not allowed' phrasing", () => {
    expect(isAppleEventsJSDisabled("JavaScript execution not allowed")).toBe(true);
  });

  it("returns true for 'Allow JavaScript' phrasing", () => {
    expect(isAppleEventsJSDisabled("Allow JavaScript from Apple Events must be enabled")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAppleEventsJSDisabled("connection refused")).toBe(false);
    expect(isAppleEventsJSDisabled("timeout")).toBe(false);
    expect(isAppleEventsJSDisabled("")).toBe(false);
  });
});

// ─── Coordinate transform edge cases ─────────────────────────────────────────

describe("coordinate transform edge cases", () => {
  it("handles non-zero viewport x offset", () => {
    const viewport = { x: 100, y: 200, width: 800, height: 600 };
    const dom: DOMElement[] = [
      { tag: "input", rect: { x: 0, y: 0, width: 200, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].bounds).toEqual({ x: 100, y: 200, width: 200, height: 36 });
  });

  it("preserves width and height unchanged", () => {
    const viewport = { x: 10, y: 80, width: 1440, height: 820 };
    const dom: DOMElement[] = [
      { tag: "button", rect: { x: 50, y: 100, width: 150, height: 44 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].bounds?.width).toBe(150);
    expect(els[0].bounds?.height).toBe(44);
  });

  it("AXButton elements have AXPress in actions", () => {
    const viewport = { x: 0, y: 80, width: 1440, height: 820 };
    const dom: DOMElement[] = [
      { tag: "button", text: "OK", rect: { x: 0, y: 0, width: 80, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].actions).toContain("AXPress");
  });

  it("AXLink elements have AXPress in actions", () => {
    const viewport = { x: 0, y: 80, width: 1440, height: 820 };
    const dom: DOMElement[] = [
      { tag: "a", text: "Click here", rect: { x: 0, y: 0, width: 100, height: 20 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].actions).toContain("AXPress");
  });

  it("input elements have empty actions array", () => {
    const viewport = { x: 0, y: 80, width: 1440, height: 820 };
    const dom: DOMElement[] = [
      { tag: "input", type: "text", rect: { x: 0, y: 0, width: 200, height: 36 } },
    ];
    const els = domElementsToAXElements(dom, viewport);
    expect(els[0].actions).toEqual([]);
  });
});
