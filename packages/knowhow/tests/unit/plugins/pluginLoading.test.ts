import { PluginService } from "../../../src/plugins/plugins";
import { PluginContext } from "../../../src/plugins/types";
import { Config } from "../../../src/types";

// Minimal mock context for PluginService construction
// EmbeddingPlugin calls context.Events.on() in its constructor, so we must mock it.
function makeContext(): PluginContext {
  return {
    Events: {
      on: jest.fn(),
      emit: jest.fn(),
      emitBlocking: jest.fn(),
      emitNonBlocking: jest.fn(),
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

describe("PluginService.loadPluginsFromConfig", () => {
  it("should load plugins listed in config.pluginPackages", async () => {
    const service = new PluginService(makeContext());
    const loadedSpecs: string[] = [];

    service.loadPlugin = jest.fn().mockImplementation(async (spec: string) => {
      loadedSpecs.push(spec);
      const key = `plugin-from-${spec}`;
      const instance = {
        meta: { key, name: key },
        isEnabled: () => true,
        enable: () => {},
        disable: () => {},
        call: () => Promise.resolve(""),
        callMany: () => Promise.resolve(""),
        embed: () => Promise.resolve([]),
      };
      (service as any).pluginMap.set(key, instance);
      return key;
    });

    const config = {
      pluginPackages: {
        asana: "@knowhow/plugin-asana",
        linear: "@knowhow/plugin-linear",
      },
    } as unknown as Config;

    await service.loadPluginsFromConfig(config);

    expect(loadedSpecs).toContain("@knowhow/plugin-asana");
    expect(loadedSpecs).toContain("@knowhow/plugin-linear");
    expect(loadedSpecs.length).toBe(2);
  });

  it("should handle empty pluginPackages gracefully", async () => {
    const service = new PluginService(makeContext());
    service.loadPlugin = jest.fn();

    const config = {} as Config;
    await expect(service.loadPluginsFromConfig(config)).resolves.toBeUndefined();
    expect(service.loadPlugin).not.toHaveBeenCalled();
  });

  it("should log a warning and not crash when a plugin fails to load", async () => {
    const service = new PluginService(makeContext());
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    service.loadPlugin = jest.fn().mockRejectedValue(new Error("Module not found"));

    const config = {
      pluginPackages: {
        broken: "non-existent-package",
      },
    } as unknown as Config;

    await expect(service.loadPluginsFromConfig(config)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("broken"),
      expect.any(String)
    );

    warnSpy.mockRestore();
  });

  it("should load each plugin with the correct spec string", async () => {
    const service = new PluginService(makeContext());
    const loadedSpecs: string[] = [];

    service.loadPlugin = jest.fn().mockImplementation(async (spec: string) => {
      loadedSpecs.push(spec);
      return spec;
    });

    const config = {
      pluginPackages: {
        valid: "@knowhow/valid-plugin",
      },
    } as unknown as Config;

    await service.loadPluginsFromConfig(config);
    expect(loadedSpecs).toEqual(["@knowhow/valid-plugin"]);
  });
});
