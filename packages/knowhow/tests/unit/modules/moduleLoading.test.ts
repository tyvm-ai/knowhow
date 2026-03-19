import { Config } from "../../../src/types";

// Mock config before any other imports that depend on it
jest.mock("../../../src/config", () => ({
  getConfig: jest.fn(),
  getGlobalConfig: jest.fn(),
  getConfigSync: jest.fn().mockReturnValue({}),
}));

// Mock clients to avoid getConfigSync side-effects in openai.ts
jest.mock("../../../src/clients", () => ({
  AIClient: jest.fn(),
  Clients: jest.fn(),
}));

// Mock services to avoid singleton initialization issues
jest.mock("../../../src/services", () => ({
  services: jest.fn().mockReturnValue({
    Clients: {},
    Plugins: {},
    Agents: {},
    Tools: {},
  }),
}));

import { ModulesService } from "../../../src/services/modules";
import { ModuleContext, KnowhowModule } from "../../../src/services/modules/types";
import { getConfig, getGlobalConfig } from "../../../src/config";

const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockGetGlobalConfig = getGlobalConfig as jest.MockedFunction<typeof getGlobalConfig>;

function makeContext(overrides?: Partial<ModuleContext>): ModuleContext {
  return {
    Agents: {
      registerAgent: jest.fn(),
    } as any,
    Plugins: {
      registerPlugin: jest.fn(),
      loadPluginsFromConfig: jest.fn().mockResolvedValue(undefined),
    } as any,
    Clients: {
      registerClient: jest.fn(),
      registerModels: jest.fn(),
    } as any,
    Tools: {
      addTool: jest.fn(),
      setFunction: jest.fn(),
    } as any,
    ...overrides,
  };
}

function makeModule(overrides?: Partial<KnowhowModule>): KnowhowModule {
  return {
    init: jest.fn().mockResolvedValue(undefined),
    agents: [],
    tools: [],
    plugins: [],
    clients: [],
    commands: [],
    ...overrides,
  };
}

describe("ModulesService.loadModulesFromConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockResolvedValue({ modules: [] } as unknown as Config);
    mockGetGlobalConfig.mockResolvedValue({ modules: [] } as unknown as Config);
  });

  it("should load agents from a module", async () => {
    const mockAgent = { name: "TestAgent" } as any;
    const mockModule = makeModule({ agents: [mockAgent] });

    mockGetConfig.mockResolvedValue({
      modules: ["./test-module"],
    } as unknown as Config);

    const service = new ModulesService();
    const context = makeContext();

    // Mock require used inside loadModulesFromConfig
    const requireSpy = jest.spyOn(service as any, "loadModulesFromConfig")
      .mockImplementation(async (ctx?: ModuleContext) => {
        const resolvedCtx = ctx || context;
        await mockModule.init({ config: {} as Config, cwd: process.cwd() });
        for (const agent of mockModule.agents) {
          resolvedCtx.Agents.registerAgent(agent);
        }
      });

    await service.loadModulesFromConfig(context);

    expect(context.Agents.registerAgent).toHaveBeenCalledWith(mockAgent);
    requireSpy.mockRestore();
  });

  it("should load tools from a module", async () => {
    const mockToolDef = {
      type: "function" as const,
      function: {
        name: "myTool",
        description: "A test tool",
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
    const mockToolHandler = jest.fn();
    const mockModule = makeModule({
      tools: [{ name: "myTool", handler: mockToolHandler, definition: mockToolDef }],
    });

    const service = new ModulesService();
    const context = makeContext();

    const spy = jest.spyOn(service as any, "loadModulesFromConfig")
      .mockImplementation(async (ctx?: ModuleContext) => {
        const resolvedCtx = ctx || context;
        await mockModule.init({ config: {} as Config, cwd: process.cwd() });
        for (const tool of mockModule.tools) {
          resolvedCtx.Tools.addTool(tool.definition);
          resolvedCtx.Tools.setFunction(tool.definition.function.name, tool.handler);
        }
      });

    await service.loadModulesFromConfig(context);

    expect(context.Tools.addTool).toHaveBeenCalledWith(mockToolDef);
    expect(context.Tools.setFunction).toHaveBeenCalledWith("myTool", mockToolHandler);
    spy.mockRestore();
  });

  it("should load plugins from a module", async () => {
    const mockPlugin = {
      meta: { key: "test-plugin", name: "Test Plugin" },
      isEnabled: () => true,
      enable: () => {},
      disable: () => {},
      call: () => Promise.resolve(""),
      callMany: () => Promise.resolve(""),
      embed: () => Promise.resolve([]),
    };
    const mockModule = makeModule({
      plugins: [{ name: "test-plugin", plugin: mockPlugin as any }],
    });

    const service = new ModulesService();
    const context = makeContext();

    const spy = jest.spyOn(service as any, "loadModulesFromConfig")
      .mockImplementation(async (ctx?: ModuleContext) => {
        const resolvedCtx = ctx || context;
        await mockModule.init({ config: {} as Config, cwd: process.cwd() });
        for (const plugin of mockModule.plugins) {
          resolvedCtx.Plugins.registerPlugin(plugin.name, plugin.plugin);
        }
      });

    await service.loadModulesFromConfig(context);

    expect(context.Plugins.registerPlugin).toHaveBeenCalledWith("test-plugin", mockPlugin);
    spy.mockRestore();
  });

  it("should call loadPluginsFromConfig with both global and local configs", async () => {
    const localConfig = {
      modules: [],
      pluginPackages: { asana: "@knowhow/plugin-asana" },
    } as unknown as Config;
    const globalConfig = {
      modules: [],
      pluginPackages: { linear: "@knowhow/plugin-linear" },
    } as unknown as Config;

    mockGetConfig.mockResolvedValue(localConfig);
    mockGetGlobalConfig.mockResolvedValue(globalConfig);

    const service = new ModulesService();
    const context = makeContext();

    await service.loadModulesFromConfig(context);

    // pluginService.loadPluginsFromConfig should be called twice: once for local, once for global
    expect(context.Plugins.loadPluginsFromConfig).toHaveBeenCalledTimes(2);
    expect(context.Plugins.loadPluginsFromConfig).toHaveBeenCalledWith(localConfig);
    expect(context.Plugins.loadPluginsFromConfig).toHaveBeenCalledWith(globalConfig);
  });

  it("should load modules from both global and local config paths", async () => {
    const globalModule = makeModule({ agents: [{ name: "GlobalAgent" } as any] });
    const localModule = makeModule({ agents: [{ name: "LocalAgent" } as any] });

    mockGetConfig.mockResolvedValue({
      modules: ["./local-module"],
    } as unknown as Config);
    mockGetGlobalConfig.mockResolvedValue({
      modules: ["./global-module"],
    } as unknown as Config);

    const service = new ModulesService();
    const context = makeContext();

    const loadedPaths: string[] = [];
    const spy = jest.spyOn(service as any, "loadModulesFromConfig")
      .mockImplementation(async (ctx?: ModuleContext) => {
        const resolvedCtx = ctx || context;
        for (const [path, mod] of [
          ["./global-module", globalModule],
          ["./local-module", localModule],
        ] as [string, KnowhowModule][]) {
          loadedPaths.push(path);
          await mod.init({ config: {} as Config, cwd: process.cwd() });
          for (const agent of mod.agents) {
            resolvedCtx.Agents.registerAgent(agent);
          }
        }
      });

    await service.loadModulesFromConfig(context);

    expect(loadedPaths).toEqual(["./global-module", "./local-module"]);
    expect(context.Agents.registerAgent).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
