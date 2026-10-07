/**
 * adapters/chrome.ts — Chrome app adapter: DOM candidates via Apple Events JS.
 *
 * When Chrome's AX tree lacks actionable web content (renderer accessibility
 * is in minimal mode), we fall back to injecting a JavaScript snippet via
 * osascript "execute active tab of front window javascript" to enumerate
 * visible actionable DOM elements and their bounding rects.
 *
 * The DOM rects are converted to global screen coordinates using the
 * AXWebArea's frame (from the AX tree) as the exact viewport origin —
 * this is more accurate than window.screenX/screenY + toolbar math.
 *
 * If Apple Events JavaScript is disabled in Chrome, we log ONE clear
 * actionable message explaining how to enable it, then return [].
 *
 * Usage:
 *   const candidates = await getChromeDOMCandidates(axElements, appName, log);
 */

import { appleScriptString, runAppleScriptSync } from "../actions/osa";
import type { AXElement, Candidate, Rect } from "../hints/types";
import type { AppAdapter } from "../targeting/adapter";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DOMElement {
  tag: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  checked?: boolean;
  disabled?: boolean;
  contenteditable?: boolean;
  rect: { x: number; y: number; width: number; height: number };
  text?: string;
}

// ─── JS snippet injected into Chrome ─────────────────────────────────────────

const DOM_EXTRACTION_JS = `
(function() {
  var actionable = [];
  var sel = 'input:not([type=hidden]), textarea, select, button, a[href], ' +
            '[role=button], [role=link], [role=checkbox], [role=radio], ' +
            '[role=textbox], [role=combobox], [role=listbox], [role=switch], ' +
            '[contenteditable=true], label[for]';
  var els = document.querySelectorAll(sel);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    var item = {
      tag: el.tagName.toLowerCase(),
      type: el.type || undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      placeholder: el.placeholder || undefined,
      name: el.name || el.getAttribute('aria-labelledby') ? 
            (el.name || document.getElementById(el.getAttribute('aria-labelledby') || '') && 
             document.getElementById(el.getAttribute('aria-labelledby') || '').textContent.trim().slice(0,40)) : undefined,
      id: el.id || undefined,
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' ? true : undefined,
      contenteditable: el.contentEditable === 'true' ? true : undefined,
      text: (el.textContent || el.value || el.innerText || '').trim().slice(0, 40) || undefined,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
    actionable.push(item);
  }
  return JSON.stringify(actionable);
})()
`.trim();

// ─── State: track if we've already warned about Apple Events JS ───────────────

let _appleEventsJSWarned = false;
const CHROME_AX_MESSAGE =
  "[smart-selector] Chrome web elements unavailable: enable View > Developer > Allow JavaScript from Apple Events, " +
  "or turn on chrome://accessibility 'Web accessibility', " +
  "or launch Chrome with --force-renderer-accessibility";

/** Reset the warning state (for tests). */
export function resetAppleEventsWarning(): void {
  _appleEventsJSWarned = false;
}

// ─── Extract AXWebArea frame from AX elements ─────────────────────────────────

/**
 * Find the AXWebArea's frame from the AX element list.
 * This is the exact viewport origin for coordinate conversion.
 */
export function findWebAreaFrame(
  axElements: Array<{ role: string; bounds?: { x: number; y: number; width: number; height: number } }>,
): Rect | null {
  const webArea = axElements.find((el) => el.role === "AXWebArea" && el.bounds);
  return webArea?.bounds ?? null;
}

// ─── Convert DOM element to AXElement-compatible Candidate ───────────────────

const DOM_ROLE_MAP: Record<string, string> = {
  input: "AXTextField",
  textarea: "AXTextArea",
  select: "AXPopUpButton",
  button: "AXButton",
  a: "AXLink",
  label: "AXStaticText",
};

const ARIA_ROLE_MAP: Record<string, string> = {
  button: "AXButton",
  link: "AXLink",
  checkbox: "AXCheckBox",
  radio: "AXRadioButton",
  textbox: "AXTextField",
  combobox: "AXComboBox",
  listbox: "AXPopUpButton",
  switch: "AXCheckBox",
};

function domRoleToAX(el: DOMElement): string {
  if (el.role && ARIA_ROLE_MAP[el.role]) return ARIA_ROLE_MAP[el.role];
  if (el.tag === "input") {
    const type = el.type?.toLowerCase();
    if (type === "checkbox") return "AXCheckBox";
    if (type === "radio") return "AXRadioButton";
    if (type === "submit" || type === "button" || type === "reset") return "AXButton";
    return "AXTextField";
  }
  return DOM_ROLE_MAP[el.tag] ?? "AXButton";
}

function domElementToAXElement(el: DOMElement, viewportOrigin: Rect, index: number): AXElement {
  const axRole = domRoleToAX(el);

  // Convert viewport-relative rect to screen coordinates
  const screenRect: Rect = {
    x: Math.round(viewportOrigin.x + el.rect.x),
    y: Math.round(viewportOrigin.y + el.rect.y),
    width: el.rect.width,
    height: el.rect.height,
  };

  const title =
    el.ariaLabel ||
    el.placeholder ||
    el.name ||
    el.text ||
    (el.id ? `#${el.id}` : undefined);

  return {
    id: `dom-${index}-${el.tag}-${el.id ?? ""}`,
    role: axRole,
    title: title?.slice(0, 40),
    description: el.placeholder || el.ariaLabel,
    value: el.checked !== undefined ? String(el.checked) : undefined,
    enabled: !el.disabled,
    bounds: screenRect,
    actions: axRole === "AXButton" || axRole === "AXLink" ? ["AXPress"] : [],
  };
}

// ─── Execute JS in Chrome via Apple Events ────────────────────────────────────

function runChromeJS(appName: string, js: string): { result: string | null; error: string | null } {
  // Use "active tab" of front window for the named app
  const script = `tell application "${appName}" to execute active tab of front window javascript ${appleScriptString(js)}`;
  const result = runAppleScriptSync(script, { timeoutMs: 5000 });
  if (!result.ok) {
    return { result: null, error: (result.stderr || result.stdout || "").trim() };
  }
  return { result: (result.stdout || "").trim(), error: null };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Get DOM-based candidates from Chrome when AX web content is unavailable.
 *
 * @param axElements - The current AX elements (used to find AXWebArea frame)
 * @param appName - The Chrome app name (e.g. "Google Chrome")
 * @param log - Logger function
 * @returns Array of AXElement-compatible objects with screen-space bounds
 */
export async function getChromeDOMElements(
  axElements: Array<{ role: string; bounds?: { x: number; y: number; width: number; height: number } }>,
  appName: string,
  log: (msg: string) => void,
): Promise<AXElement[]> {
  // Find viewport origin from AXWebArea frame
  const webAreaFrame = findWebAreaFrame(axElements);
  if (!webAreaFrame) {
    log("[chrome-dom] No AXWebArea frame found — cannot compute screen coordinates");
    return [];
  }

  log(`[chrome-dom] AXWebArea frame: x=${webAreaFrame.x}, y=${webAreaFrame.y}, ${webAreaFrame.width}×${webAreaFrame.height}`);

  // Execute JS in Chrome
  const { result, error } = runChromeJS(appName, DOM_EXTRACTION_JS);

  if (error !== null || result === null) {
    if (!_appleEventsJSWarned) {
      _appleEventsJSWarned = true;
      log(CHROME_AX_MESSAGE);
    }
    return [];
  }

  // Parse JSON result
  let domElements: DOMElement[];
  try {
    // osascript may wrap the result in quotes or add a newline
    const cleaned = result.replace(/^"|"$/g, "").replace(/\\"/g, '"');
    domElements = JSON.parse(cleaned);
    if (!Array.isArray(domElements)) {
      log("[chrome-dom] Unexpected DOM result format");
      return [];
    }
  } catch (e) {
    log(`[chrome-dom] Failed to parse DOM result: ${e}`);
    return [];
  }

  log(`[chrome-dom] Found ${domElements.length} DOM elements`);

  // Convert to AXElement format
  const axElements2 = domElements
    .filter((el) => !el.disabled)
    .map((el, i) => domElementToAXElement(el, webAreaFrame, i));

  return axElements2;
}

// ─── Unit-testable pure functions ─────────────────────────────────────────────

/**
 * Convert an array of DOM elements + viewport origin to AXElements.
 * Pure function for unit testing (no osascript calls).
 */
export function domElementsToAXElements(
  domElements: DOMElement[],
  viewportOrigin: Rect,
): AXElement[] {
  return domElements
    .filter((el) => !el.disabled)
    .map((el, i) => domElementToAXElement(el, viewportOrigin, i));
}

/**
 * Check if an error from Chrome Apple Events JS indicates it's disabled.
 */
export function isAppleEventsJSDisabled(error: string): boolean {
  // Error code 12 = "Apple Events JavaScript not enabled"
  // -1728 = can't get object
  return error.includes("(-12)") || error.includes("code 12") ||
    error.includes("not enabled") || error.includes("not allowed") ||
    error.includes("Allow JavaScript");
}

// ─── The adapter ──────────────────────────────────────────────────────────────

/** Chromium browsers whose active tab can run JavaScript through Apple Events. */
export const CHROME_APP = /chrom|brave|edge|vivaldi|opera|\barc\b/i;

export const chromeAdapter: AppAdapter = {
  name: "chrome",
  app: CHROME_APP,
  /** When the AX tree has no actionable web content, read the DOM of the active tab. */
  async extraElements({ elements, appName, axLooksEmpty, log }) {
    if (!axLooksEmpty) return [];
    log(`[smart-selector] AX has no actionable web content; trying Chrome DOM provider for "${appName}"...`);
    const dom = await getChromeDOMElements(elements, appName, log);
    log(
      dom.length > 0
        ? `[smart-selector] Chrome DOM provider returned ${dom.length} elements`
        : "[smart-selector] Chrome DOM provider returned no elements"
    );
    return dom;
  },
};
