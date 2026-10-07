import { stderrSink, taggedLogger } from "./services/logger";
/**
 * axEnabler.ts — Auto-enable web accessibility for Chromium/Electron apps.
 *
 * Chrome/Electron expose only toolbar AX elements by default; web content
 * (AXWebArea and children) only appears after accessibility is enabled on the
 * AXUIElement for the app process.
 *
 * Strategy:
 *  1. Compile a tiny Swift helper to ~/.cache/knowhow/voice/ax-enable (only on
 *     first use or when the source hash changes) and call `ax-enable <pid>`.
 *     Tries AXManualAccessibility first (Electron), then AXEnhancedUserInterface.
 *
 * NOTE: The JXA (JavaScript for Automation / ObjC bridge) path was removed because
 * AXUIElementSetAttributeValue returns error codes (-25205, -25208) that prevent it
 * from actually setting the attribute in modern Chrome. The Swift helper uses
 * ApplicationServices directly and handles these gracefully.
 *
 * Results are cached per pid so we only enable once per process lifetime.
 */

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Cache ──────────────────────────────────────────────────────────────────

/** pid → which attribute was enabled ("already-enabled" | "manual" | "enhanced" | "none" | "failed") */
const _pidCache = new Map<number, string>();

export function getAXEnablerCache(): Map<number, string> {
  return _pidCache;
}

export function clearAXEnablerCache(): void {
  _pidCache.clear();
}

// ─── Swift source ─────────────────────────────────────────────────────────────

const SWIFT_SOURCE = `
import Cocoa
import ApplicationServices

@discardableResult
func setAttribute(_ app: AXUIElement, _ attr: String, _ value: Bool) -> Bool {
    let ref = value as CFBoolean
    let result = AXUIElementSetAttributeValue(app, attr as CFString, ref)
    return result == .success || result == AXError(rawValue: -25204)! // kAXErrorAttributeUnsupported treated as "already set"
}

func hasWebContent(_ app: AXUIElement) -> Bool {
    var children: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &children)
    guard r == .success, let arr = children as? [AXUIElement] else { return false }
    func search(_ el: AXUIElement, depth: Int) -> Bool {
        guard depth > 0 else { return false }
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role) == .success,
           let r = role as? String, r == "AXWebArea" { return true }
        var kids: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kids) == .success,
           let arr2 = kids as? [AXUIElement] {
            for k in arr2 { if search(k, depth: depth - 1) { return true } }
        }
        return false
    }
    for child in arr { if search(child, depth: 8) { return true } }
    return false
}

func countActionableDescendants(_ el: AXUIElement, depth: Int) -> Int {
    guard depth > 0 else { return 0 }
    var role: CFTypeRef?
    var count = 0
    let actionableRoles: Set<String> = [
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox"
    ]
    if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role) == .success,
       let r = role as? String, actionableRoles.contains(r) {
        count += 1
    }
    var kids: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kids) == .success,
       let arr = kids as? [AXUIElement] {
        for k in arr { count += countActionableDescendants(k, depth: depth - 1) }
    }
    return count
}

func hasActionableWebContent(_ app: AXUIElement) -> Bool {
    var children: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &children)
    guard r == .success, let arr = children as? [AXUIElement] else { return false }
    func findWebArea(_ el: AXUIElement, depth: Int) -> AXUIElement? {
        guard depth > 0 else { return nil }
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role) == .success,
           let r = role as? String, r == "AXWebArea" { return el }
        var kids: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kids) == .success,
           let arr2 = kids as? [AXUIElement] {
            for k in arr2 { if let found = findWebArea(k, depth: depth - 1) { return found } }
        }
        return nil
    }
    for child in arr {
        if let webArea = findWebArea(child, depth: 8) {
            return countActionableDescendants(webArea, depth: 12) > 0
        }
    }
    return false
}

guard CommandLine.arguments.count > 1, let pid = Int32(CommandLine.arguments[1]) else {
    fputs("Usage: ax-enable <pid>\\n", stderr)
    exit(1)
}

let app = AXUIElementCreateApplication(pid_t(pid))

// Check if web content already present AND has actionable elements
if hasActionableWebContent(app) {
    print("ok:already-enabled")
    exit(0)
}

// Try AXManualAccessibility first (Chrome/Electron flag; less disruptive)
setAttribute(app, "AXManualAccessibility", true)
Thread.sleep(forTimeInterval: 0.35)

if hasActionableWebContent(app) {
    print("ok:manual")
    exit(0)
}

// Fall back to AXEnhancedUserInterface
setAttribute(app, "AXEnhancedUserInterface", true)
Thread.sleep(forTimeInterval: 0.45)

if hasActionableWebContent(app) {
    print("ok:enhanced")
    exit(0)
}

// Check if there's a web area at all (even without actionable content)
if hasWebContent(app) {
    print("none:web-area-exists-but-empty")
    exit(0)
}

print("none")
exit(0)
`.trim();

// ─── Swift helper ─────────────────────────────────────────────────────────────

const AX_CACHE_DIR = join(homedir(), ".cache", "knowhow", "voice");
const AX_BINARY = join(AX_CACHE_DIR, "ax-enable");
const AX_HASH_FILE = join(AX_CACHE_DIR, "ax-enable.hash");
const AX_SOURCE_FILE = join(AX_CACHE_DIR, "ax-enable.swift");

function sourceHash(): string {
  return createHash("sha256").update(SWIFT_SOURCE).digest("hex").slice(0, 16);
}

function ensureSwiftBinary(): boolean {
  const hash = sourceHash();
  // Check if binary exists and hash matches
  if (existsSync(AX_BINARY) && existsSync(AX_HASH_FILE)) {
    try {
      const stored = readFileSync(AX_HASH_FILE, "utf8").trim();
      if (stored === hash) return true;
    } catch { /* recompile */ }
  }
  try {
    mkdirSync(AX_CACHE_DIR, { recursive: true });
    writeFileSync(AX_SOURCE_FILE, SWIFT_SOURCE);
    const compile = spawnSync(
      "swiftc",
      ["-O", "-o", AX_BINARY, AX_SOURCE_FILE],
      { timeout: 30000, encoding: "utf8" },
    );
    if (compile.status !== 0) {
      taggedLogger("ax-enabler", stderrSink).error(`swiftc failed: ${compile.stderr}`);
      return false;
    }
    writeFileSync(AX_HASH_FILE, hash);
    return true;
  } catch (e) {
    taggedLogger("ax-enabler", stderrSink).error(`compile error: ${e}`);
    return false;
  }
}

function trySwift(pid: number): string | null {
  if (!ensureSwiftBinary()) return null;
  try {
    const result = spawnSync(AX_BINARY, [String(pid)], {
      timeout: 5000,
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enable web accessibility for the given pid if it isn't already.
 * Returns the method used: "already-enabled", "manual", "enhanced", "none", "none:web-area-exists-but-empty", or "failed".
 * Results are cached per pid so we only enable once per process lifetime.
 */
export async function enableAXForPid(
  pid: number,
  log: (msg: string) => void = () => undefined,
): Promise<string> {
  if (_pidCache.has(pid)) {
    return _pidCache.get(pid)!;
  }

  log(`[ax-enabler] Attempting to enable web AX for pid ${pid}...`);

  const result = trySwift(pid);
  if (result) {
    log(`[ax-enabler] Swift result for pid ${pid}: ${result}`);
    _pidCache.set(pid, result);
    return result;
  }

  log(`[ax-enabler] Swift helper failed for pid ${pid}`);
  _pidCache.set(pid, "failed");
  return "failed";
}

/**
 * Check if elements from an AX query include web content (AXWebArea descendant).
 * Used to decide if enableAXForPid is needed.
 */
export function hasWebContent(elements: Array<{ role: string }>): boolean {
  return elements.some((el) => el.role === "AXWebArea");
}

/**
 * Check if an AX element list has actionable descendants (inputs, buttons, links)
 * in/under the AXWebArea. Returns false if the web area is empty/missing.
 */
export function hasActionableWebContent(elements: Array<{ role: string }>): boolean {
  const ACTIONABLE = new Set([
    "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox",
  ]);
  return elements.some((el) => ACTIONABLE.has(el.role));
}

/**
 * Determine if the given AX element list looks like a sparse/toolbar-only Chrome tree
 * where web content is missing or empty.
 * Returns true if we should attempt to enable web AX.
 *
 * Triggers when:
 * - AXWebArea exists but has NO actionable descendants (inputs/buttons/links), OR
 * - No AXWebArea at all and fewer than 5 total interactive elements
 */
export function shouldEnableWebAX(
  elements: Array<{ role: string; bounds?: { x: number; y: number; width: number; height: number } }>,
): boolean {
  const hasWebArea = hasWebContent(elements);

  if (hasWebArea) {
    // Web area exists but check if it has actionable descendants
    return !hasActionableWebContent(elements);
  }

  // No web area — check if it's sparse (toolbar-only)
  const actionable = elements.filter(
    (el) =>
      el.role !== "AXScrollBar" &&
      el.role !== "AXSplitter" &&
      el.role !== "AXGroup" &&
      el.role !== "AXWindow" &&
      el.role !== "AXApplication",
  );
  return actionable.length < 5;
}
