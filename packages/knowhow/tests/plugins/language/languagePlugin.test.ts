jest.mock("../../../src/utils", () => ({
  readFile: jest.fn().mockReturnValue(Buffer.from("test")),
  fileExists: jest.fn().mockReturnValue(true),
  fileStat: jest.fn().mockResolvedValue({
    isDirectory: jest.fn().mockReturnValue(false),
    isFile: jest.fn().mockReturnValue(true),
    size: 1024,
  }),
}));

jest.mock("../../../src/services/EventService", () => ({
  EventService: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));
jest.mock("../../../src/config", () => ({
  getConfig: jest.fn(),
  getConfigSync: jest.fn(),
  getLanguageConfig: jest.fn(),
}));

jest.mock("../../../src/plugins/plugins", () => ({
  PluginService: jest.fn().mockImplementation(() => ({
    listPlugins: jest.fn(),
    call: jest.fn(),
  })),
}));

import { LanguagePlugin } from "../../../src/plugins/language";
import { Config } from "../../../src/types";
import { EventService } from "../../../src/services/EventService";
import * as utils from "../../../src/utils";
import { getConfig, getLanguageConfig } from "../../../src/config";
import { PluginService } from "../../../src/plugins/plugins";

import { minimatch } from "minimatch";
const mockedConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockedLanguageConfig = getLanguageConfig as jest.MockedFunction<
  typeof getLanguageConfig
>;

// Use minimatch for consistent pattern matching with the plugin
const matchGlobPattern = (pattern: string, text: string) =>
  minimatch(text, pattern);

describe("matchGlobPattern", () => {
  it("should match exact patterns", () => {
    expect(
      matchGlobPattern("src/components/Button.ts", "src/components/Button.ts")
    ).toBe(true);
  });

  it("should match wildcard patterns", () => {
    expect(matchGlobPattern("**/*.ts", "Button.ts")).toBe(true);
    expect(matchGlobPattern("**/*.ts", "src/components/Button.ts")).toBe(true);
    expect(matchGlobPattern("src/**", "src/components")).toBe(true);
  });
});

const MockedPluginService = PluginService as jest.MockedClass<
  typeof PluginService
>;
const MockedEventService = EventService as jest.MockedClass<
  typeof EventService
>;

describe("LanguagePlugin", () => {
  const userPrompt = "test prompt including terms";

  test("should call the correct plugins based on the user prompt", async () => {
    const mockPluginService = new MockedPluginService({} as any);
    const mockEventService = {
      on: jest.fn(),
      emit: jest.fn(),
    };
    const mockListPlugins = jest.fn().mockReturnValue(["github", "asana"]);
    const mockCall = jest.fn().mockResolvedValue(["mocked plugin response"]);

    mockPluginService.listPlugins = mockListPlugins;
    mockPluginService.call = mockCall;

    mockedConfig.mockResolvedValue({ plugins: ["github", "asana"] } as Config);
    mockedLanguageConfig.mockResolvedValue({
      test: {
        events: [],
        sources: [
          { kind: "github", data: ["http://github.com/test"] },
          { kind: "asana", data: ["http://asana.com/test"] },
          { kind: "file", data: ["../.knowhow/knowhow.json"] },
        ],
      },
    });

    const languagePlugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);
    const pluginResponse = await languagePlugin.call(userPrompt);

    expect(utils.fileExists).toHaveBeenCalled();
    expect(utils.readFile).toHaveBeenCalled();
    expect(mockListPlugins).toHaveBeenCalled();
    expect(mockCall).toHaveBeenCalledWith("github", expect.any(String));
    expect(mockCall).toHaveBeenCalledWith("asana", expect.any(String));
    expect(pluginResponse).toContain(
      "LANGUAGE PLUGIN: The user mentioned these terms triggering contextual expansions"
    );
  });

  describe("Event-driven context expansion", () => {
    let mockEventService: any;
    let mockPluginService: any;
    let eventHandlers: Map<string, Function>;

    beforeEach(() => {
      eventHandlers = new Map();
      mockEventService = {
        on: jest.fn((event: string, handler: Function) => {
          eventHandlers.set(event, handler);
        }),
        emit: jest.fn((event: string, data: any) => {
          return true;
        }),
      };

      mockPluginService = new MockedPluginService({} as any);
      mockPluginService.listPlugins = jest.fn().mockReturnValue(["github"]);
      mockPluginService.call = jest
        .fn()
        .mockResolvedValue(["plugin context data"]);
    });

    test("should register event handlers for configured events during initialization", async () => {
      mockedLanguageConfig.mockResolvedValue({
        "*.ts,*.js": {
          events: ["file:post-edit", "file:create"],
          sources: [{ kind: "file", data: ["src/config.ts"] }],
        },
        "package.json": {
          events: ["file:post-edit"],
          sources: [{ kind: "text", data: ["Package configuration"] }],
        },
      });

      new LanguagePlugin({
        Events: mockEventService,
        Plugins: mockPluginService,
      } as any);

      // Wait for async setupEventHandlers to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockEventService.on).toHaveBeenCalledWith(
        "file:post-edit",
        expect.any(Function)
      );
      expect(mockEventService.on).toHaveBeenCalledWith(
        "file:create",
        expect.any(Function)
      );
    });

    test("should handle file:post-edit event and emit agent:msg when file pattern matches", async () => {
      mockedConfig.mockResolvedValue({ plugins: ["github"] } as Config);
      mockedLanguageConfig.mockResolvedValue({
        "**/*.ts": {
          events: ["file:post-edit"],
          sources: [
            { kind: "file", data: ["src/types.ts"] },
            { kind: "github", data: ["https://github.com/repo/issues/123"] },
          ],
        },
      });

      new LanguagePlugin({
        Events: mockEventService,
        Plugins: mockPluginService,
      } as any);

      // Wait for async setupEventHandlers to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Simulate file:post-edit event
      const fileEditHandler = eventHandlers.get("file:post-edit");
      expect(fileEditHandler).toBeDefined();

      await fileEditHandler!({
        filePath: "src/components/Button.ts",
        operation: "edit",
      });

      // Wait for async event processing to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockEventService.emit).toHaveBeenCalledWith(
        "agent:msg",
        expect.any(String)
      );

      const emitCall = mockEventService.emit.mock.calls.find(
        (call) => call[0] === "agent:msg"
      );

      expect(emitCall).toBeDefined();
      // Extract JSON from <Workflow> tags
      const workflowContent = emitCall[1].match(/<Workflow>\s*(\{[\s\S]*?\})\s*<\/Workflow>/);
      expect(workflowContent).toBeDefined();
      const eventData = JSON.parse(workflowContent[1]);
      expect(eventData.type).toBe("language_context_trigger");
      expect(eventData.matchingTerms).toEqual(["**/*.ts"]);
      expect(eventData.eventType).toBe("file:post-edit");
      expect(eventData.resolvedSources).toBeDefined();
    });

    test("should not emit agent:msg when file pattern does not match", async () => {
      mockedLanguageConfig.mockResolvedValue({
        "*.ts": {
          events: ["file:post-edit"],
          sources: [{ kind: "file", data: ["src/types.ts"] }],
        },
      });

      new LanguagePlugin({
        Events: mockEventService,
        Plugins: mockPluginService,
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const fileEditHandler = eventHandlers.get("file:post-edit");
      await fileEditHandler!({
        filePath: "README.md", // Does not match *.ts pattern
        operation: "edit",
      });

      expect(mockEventService.emit).not.toHaveBeenCalledWith(
        "agent:msg",
        expect.anything()
      );
    });

    test("should handle multiple matching patterns for a single file", async () => {
      mockedConfig.mockResolvedValue({ plugins: [] } as Config);
      mockedLanguageConfig.mockResolvedValue({
        "*.ts": {
          events: ["file:post-edit"],
          sources: [{ kind: "text", data: ["TypeScript context"] }],
        },
        "src/**": {
          events: ["file:post-edit"],
          sources: [{ kind: "text", data: ["Source directory context"] }],
        },
      });

      new LanguagePlugin({
        Events: mockEventService,
        Plugins: mockPluginService,
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const fileEditHandler = eventHandlers.get("file:post-edit");
      await fileEditHandler!({
        filePath: "src/components/Button.ts",
      });
      // Wait for async event processing to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      const emitCall = mockEventService.emit.mock.calls.find(
        (call) => call[0] === "agent:msg"
      );
      // Extract JSON from <Workflow> tags
      const workflowContent = emitCall![1].match(/<Workflow>\s*(\{[\s\S]*?\})\s*<\/Workflow>/);
      expect(workflowContent).toBeDefined();
      const eventData = JSON.parse(workflowContent![1]);
      // With minimatch, *.ts doesn't match src/components/Button.ts (needs **/*.ts)
      // Only src/** pattern matches src/components/Button.ts
      expect(eventData.matchingTerms).toContain("src/**");
    });

    test("should only trigger on configured events for a term", async () => {
      mockedLanguageConfig.mockResolvedValue({
        "*.ts": {
          events: ["file:create"], // Only configured for create, not edit
          sources: [{ kind: "text", data: ["TypeScript context"] }],
        },
      });

      new LanguagePlugin({
        Events: mockEventService,
        Plugins: mockPluginService,
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const fileEditHandler = eventHandlers.get("file:post-edit");
      if (fileEditHandler) {
        await fileEditHandler({
          filePath: "src/Button.ts",
        });
      }

      expect(mockEventService.emit).not.toHaveBeenCalledWith(
        "agent:msg",
        expect.anything()
      );
    });

    test("should resolve different source types in event context", async () => {
      mockedConfig.mockResolvedValue({ plugins: ["github"] } as Config);
      mockedLanguageConfig.mockResolvedValue({
        "*.json": {
          events: ["file:post-edit"],
          sources: [
            { kind: "file", data: ["config/settings.json"] },
            { kind: "text", data: ["JSON configuration files"] },
            { kind: "github", data: ["https://github.com/repo/config"] },
          ],
        },
      });

      new LanguagePlugin({
        Events: mockEventService,
        Plugins: mockPluginService,
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const fileEditHandler = eventHandlers.get("file:post-edit");
      await fileEditHandler!({
        filePath: "package.json",
      });

      expect(utils.fileExists).toHaveBeenCalledWith("config/settings.json");
      expect(utils.readFile).toHaveBeenCalledWith(
        "config/settings.json",
        "utf8"
      );
      expect(mockPluginService.call).toHaveBeenCalledWith(
        "github",
        "https://github.com/repo/config"
      );
      expect(mockEventService.emit).toHaveBeenCalledWith(
        "agent:msg",
        expect.stringMatching(
          /<Workflow>[\s\S]*language_context_trigger[\s\S]*<\/Workflow>/
        )
      );
    });
  });

  test("should return a message if no matching terms found", async () => {
    const mockEventService = {
      on: jest.fn(),
      emit: jest.fn(),
    };
    const mockPluginService = new MockedPluginService({} as any);
    const mockListPlugins = jest.fn().mockReturnValue(["github"]);

    mockPluginService.listPlugins = mockListPlugins;

    mockedConfig.mockResolvedValue({ plugins: ["github"] } as Config);
    mockedLanguageConfig.mockResolvedValue({});

    const languagePlugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);
    const pluginResponse = await languagePlugin.call(userPrompt);

    expect(pluginResponse).toEqual("LANGUAGE PLUGIN: No matching terms found");
  });
});
