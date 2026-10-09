import * as sdk from "../../src/sdk";
import { createModuleRuntime } from "../../src/services/modules/runtime";

describe("@tyvm/knowhow/sdk", () => {
  it("exposes the module-facing API", () => {
    for (const name of [
      "services", "getConfig", "getConfigSync", "getGlobalConfig", "setupServices",
      "voiceToText", "ensureDefaultMic", "ExtensionsService", "ToolsService", "BaseAgent",
      "withFallback", "createModuleRuntime",
      "normalizeCommandAction", "isInteractiveAgent",
    ]) {
      expect((sdk as any)[name]).toBeDefined();
    }
  });

  it("services() lazily returns the singleton container", () => {
    expect(sdk.services().Extensions).toBeInstanceOf(sdk.ExtensionsService);
    expect(sdk.services().Tools).toBeInstanceOf(sdk.ToolsService);
  });
});

describe("createModuleRuntime", () => {
  it("returns services/config and disposes callbacks once, in reverse order", async () => {
    const rt = await createModuleRuntime();
    expect(rt.services.Extensions).toBe(rt.extensions);
    expect(rt.config).toBeDefined();
    const order: number[] = [];
    rt.onDispose(() => { order.push(1); });
    rt.onDispose(async () => { order.push(2); });
    await rt.dispose();
    await rt.dispose();
    expect(order).toEqual([2, 1]);
    expect(rt.disposed).toBe(true);
  });

  it("runs every disposer even if one fails, then reports", async () => {
    const rt = await createModuleRuntime();
    const ran = jest.fn();
    rt.onDispose(ran);
    rt.onDispose(() => { throw new Error("bad"); });
    await expect(rt.dispose()).rejects.toThrow(/bad/);
    expect(ran).toHaveBeenCalled();
  });
});
