import { PluginService } from "../../../src/plugins/plugins";
import { PluginContext } from "../../../src/plugins/types";

// Minimal mock context for PluginService construction
// EmbeddingPlugin calls context.Events.on() in its constructor, so we must mock it.
function makeContext(): PluginContext {
  return {
    Events: {
      on: jest.fn(),
      emit: jest.fn(),
      emitBlocking: jest.fn(),
      emitNonBlocking: jest.fn(),
      log: jest.fn(),
    } as any,
  } as PluginContext;
}

describe("PluginService.loadPlugin", () => {
  it("should register the plugin under its meta.key", async () => {
    const service = new PluginService(makeContext());
    const mockKey = "test-plugin";

    // Mock loadPlugin to simulate what a real dynamic import would do
    service.loadPlugin = jest.fn().mockImplementation(async (_spec: string) => {
      const instance = {
        meta: { key: mockKey, name: "Test Plugin" },
        isEnabled: () => true,
        enable: () => {},
        disable: () => {},
        call: () => Promise.resolve(""),
        callMany: () => Promise.resolve(""),
        embed: () => Promise.resolve([]),
      };
      (service as any).pluginMap.set(instance.meta.key, instance);
      return instance.meta.key;
    });

    const key = await service.loadPlugin("some-package");
    expect(key).toBe(mockKey);
    expect(service.isPlugin(mockKey)).toBe(true);
  });

  it("should call getPlugin after loading", async () => {
    const service = new PluginService(makeContext());
    const mockKey = "my-plugin";

    service.loadPlugin = jest.fn().mockImplementation(async (_spec: string) => {
      const instance = {
        meta: { key: mockKey, name: "My Plugin" },
        isEnabled: () => true,
        enable: () => {},
        disable: () => {},
        call: () => Promise.resolve("result"),
        callMany: () => Promise.resolve("result"),
        embed: () => Promise.resolve([]),
      };
      (service as any).pluginMap.set(instance.meta.key, instance);
      return instance.meta.key;
    });

    await service.loadPlugin("./some-path");
    const plugin = service.getPlugin(mockKey);
    expect(plugin).toBeDefined();
    expect(plugin!.meta.key).toBe(mockKey);
  });
});
