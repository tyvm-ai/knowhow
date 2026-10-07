/**
 * Platform adapter registry + factory.
 *
 * External modules can register additional platform adapters via:
 *   registerPlatformAdapter(extension)
 *
 * where extension is a PlatformAdapterExtension with:
 *   { type: "voice-control.platform", platform: "win32", name, create() }
 *
 * Core picks the adapter for process.platform automatically.
 */

import type { PlatformActions, PlatformAdapterExtension } from "./types";
import { DarwinPlatformActions } from "./darwin";
import { getComputerService } from "../computerService";

// Re-export types (snapRect, resolveMonitor etc live in types.ts)
export * from "./types";
// Re-export snap helpers (sortAndIndexMonitors, monitorForPoint) — no conflicts
export { sortAndIndexMonitors, monitorForPoint } from "./snap";
// Re-export darwin adapter
export { DarwinPlatformActions } from "./darwin";

// ─── Adapter registry ─────────────────────────────────────────────────────────

const _externalAdapters: PlatformAdapterExtension[] = [];

/** Register an external platform adapter (e.g. from a win32 or linux module). */
export function registerPlatformAdapter(ext: PlatformAdapterExtension): void {
  const existing = _externalAdapters.findIndex(
    (e) => e.platform === ext.platform && e.name === ext.name,
  );
  if (existing >= 0) {
    _externalAdapters[existing] = ext;
  } else {
    _externalAdapters.push(ext);
  }
}

/**
 * Get the PlatformActions adapter for the current platform.
 *
 * @param computerService - Optional ComputerService instance to inject into adapters.
 * @param platform - Override process.platform (for testing).
 */
export function getPlatformActions(
  computerService?: unknown,
  platform?: NodeJS.Platform,
): PlatformActions {
  const plat = platform ?? process.platform;

  // Check external adapters first (allows overriding built-ins).
  const external = _externalAdapters.find((a) => a.platform === plat);
  if (external) {
    return external.create({ computerService });
  }

  if (plat === "darwin") {
    return new DarwinPlatformActions(computerService as any);
  }

  // Stub for unsupported platforms — gives a clear error message.
  return makeUnsupportedAdapter(plat);
}

let _shared: { platform: NodeJS.Platform; actions: PlatformActions } | undefined;

/**
 * Process-wide PlatformActions for the current platform (created lazily, so
 * short-TTL caches such as `frontmostApp({ maxAgeMs })` are shared by every
 * caller). Use `getPlatformActions()` when you need an isolated instance.
 */
export function sharedPlatformActions(): PlatformActions {
  if (!_shared || _shared.platform !== process.platform) {
    _shared = { platform: process.platform, actions: getPlatformActions(getComputerService()) };
  }
  return _shared.actions;
}

function makeUnsupportedAdapter(platform: string): PlatformActions {
  const err = () =>
    Promise.reject(
      new Error(
        `voice-control platform actions not supported on "${platform}". ` +
          `Register a "voice-control.platform" adapter module.`,
      ),
    );
  return {
    platform: platform as NodeJS.Platform,
    pressCombo: err,
    typeText: err,
    frontmostApp: () => Promise.resolve(undefined),
    activateApp: () => Promise.resolve(false),
    listMonitors: () => Promise.resolve([]),
    frontWindow: () => Promise.resolve(undefined),
    windowAt: () => Promise.resolve(undefined),
    setWindowBounds: err,
    minimizeWindow: err,
    restoreWindow: err,
    toggleFullScreen: err,
    scroll: err,
    systemAction: err,
  };
}
