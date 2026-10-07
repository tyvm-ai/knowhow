/**
 * Shared resolver for the computer-use ComputerService.
 *
 * Order: the service the computer-use module injected into the knowhow Tools
 * context (`Tools.getContext().ComputerUse`), else a standalone
 * ComputerService with the Rust core driver.
 *
 * This is the ONLY file in voice-control that `require()`s
 * `@tyvm/knowhow-module-computer-use`; everything else gets the typed
 * `ComputerUseAdapter` from here.
 */

import { services } from "@tyvm/knowhow/sdk";
import type { ComputerUseAdapter } from "./hints/types";

export type { ComputerUseAdapter } from "./hints/types";

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

/**
 * Resolve the computer-use service: the one the computer-use module injected
 * into the knowhow Tools context, else a standalone ComputerService. Not
 * cached here — `services.computer` (see services/index.ts) caches it per session.
 */
export function resolveComputerService(): ComputerUseAdapter | undefined {
  try {
    const ctxService = services()?.Tools?.getContext?.()?.ComputerUse;
    if (ctxService && typeof ctxService.accessibilityElements === "function") {
      return ctxService as ComputerUseAdapter;
    }
  } catch {
    // knowhow core not resolvable here
  }
  return createStandaloneComputerService();
}
