/**
 * Shared resolver for the computer-use ComputerService.
 *
 * Order: the service the computer-use module injected into the knowhow Tools
 * context (`Tools.getContext().ComputerUse`), else a standalone
 * ComputerService with the Rust core driver. Cached after first success.
 *
 * This is the ONLY file in voice-control that `require()`s
 * `@tyvm/knowhow-module-computer-use`; everything else gets the typed
 * `ComputerUseAdapter` from here.
 */

import type { ComputerUseAdapter } from "./smartSelector";

export type { ComputerUseAdapter } from "./smartSelector";

let cached: ComputerUseAdapter | undefined;

export function setComputerService(service: unknown): void {
  if (service && typeof (service as { typeText?: unknown }).typeText === "function") {
    cached = service as ComputerUseAdapter;
  }
}

/**
 * Build a standalone ComputerService backed by the native Rust core driver
 * (not cached, not taken from the Tools context). Undefined when
 * computer-use or its native core is unavailable.
 */
export function createStandaloneComputerService(): ComputerUseAdapter | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cu = require("@tyvm/knowhow-module-computer-use");
    const service = new cu.ComputerService();
    const driver = cu.RustCoreDriver?.tryLoad?.();
    if (driver) {
      service.registerDriver(driver);
      return service as ComputerUseAdapter;
    }
  } catch {
    // computer-use optional
  }
  return undefined;
}

export function getComputerService(): ComputerUseAdapter | undefined {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { services } = require("@tyvm/knowhow/ts_build/src/services");
    const ctxService = services()?.Tools?.getContext?.()?.ComputerUse;
    if (ctxService && typeof ctxService.accessibilityElements === "function") {
      cached = ctxService as ComputerUseAdapter;
      return cached;
    }
  } catch {
    // knowhow core not resolvable here
  }
  const standalone = createStandaloneComputerService();
  if (standalone) cached = standalone;
  return cached;
}
