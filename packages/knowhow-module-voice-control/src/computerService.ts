/**
 * Shared resolver for the computer-use ComputerService.
 *
 * Order: the service the computer-use module injected into the knowhow Tools
 * context (`Tools.getContext().ComputerUse`), else a standalone
 * ComputerService with the Rust core driver. Cached after first success.
 */

let cached: any | undefined;

export function setComputerService(service: unknown): void {
  if (service && typeof (service as any).typeText === "function") cached = service;
}

export function getComputerService(): any | undefined {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { services } = require("@tyvm/knowhow/ts_build/src/services");
    const ctxService = services()?.Tools?.getContext?.()?.ComputerUse;
    if (ctxService && typeof ctxService.accessibilityElements === "function") {
      cached = ctxService;
      return cached;
    }
  } catch {
    // knowhow core not resolvable here
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cu = require("@tyvm/knowhow-module-computer-use");
    const service = new cu.ComputerService();
    const driver = cu.RustCoreDriver?.tryLoad?.();
    if (driver) {
      service.registerDriver(driver);
      cached = service;
      return cached;
    }
  } catch {
    // computer-use optional
  }
  return undefined;
}
