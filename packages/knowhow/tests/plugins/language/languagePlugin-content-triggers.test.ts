import { LanguagePlugin } from "../../../src/plugins/language";
import { EventService } from "../../../src/services/EventService";
import { PluginService } from "../../../src/plugins/plugins";
import * as utils from "../../../src/utils";
import { getConfig, getLanguageConfig } from "../../../src/config";

jest.mock("../../../src/utils", () => ({
  readFile: jest.fn(),
  fileExists: jest.fn().mockReturnValue(true),
  fileStat: jest.fn(),
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

const mockedConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const mockedLanguageConfig = getLanguageConfig as jest.MockedFunction<
  typeof getLanguageConfig
>;
const mockedReadFile = utils.readFile as jest.MockedFunction<
  typeof utils.readFile
>;

describe("LanguagePlugin - Content-Based Triggering", () => {
  let mockEventService: any;
  let mockPluginService: any;
  let eventHandlers: Map<string, Function>;

  beforeEach(() => {
    eventHandlers = new Map();
    mockEventService = {
      on: jest.fn((event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }),
      emit: jest.fn(),
    };

    mockPluginService = {
      listPlugins: jest.fn().mockReturnValue(["github"]),
      call: jest.fn().mockResolvedValue(["plugin context data"]),
    };

    jest.clearAllMocks();
  });

  test("should trigger on file content containing test functions", async () => {
    // Mock file content that contains test functions
    const fileContentWithTests = `
      import { expect } from 'jest';

      describe('MyComponent', () => {
        test('should render correctly', () => {
          expect(component).toBeTruthy();
        });

        it('should handle click events', () => {
          // test implementation
        });
      });
    `;

    mockedReadFile.mockResolvedValue(Buffer.from(fileContentWithTests));
    mockedConfig.mockResolvedValue({
      plugins: [],
      modules: [],
      promptsDir: ".knowhow/prompts",
      sources: [],
      embedSources: [],
      embeddingModel: "text-embedding-ada-002",
      agents: [],
      mcps: [],
      modelProviders: [],
    });
    mockedLanguageConfig.mockResolvedValue({
      "test(": {
        events: ["file:post-read"],
        sources: [
          { kind: "text", data: ["Jest testing best practices"] },
          { kind: "file", data: ["docs/testing-guidelines.md"] },
        ],
      },
    });

    new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Trigger file:post-read event
    const fileReadHandler = eventHandlers.get("file:post-read");
    expect(fileReadHandler).toBeDefined();

    await fileReadHandler!({
      filePath: "src/components/MyComponent.spec.ts",
      operation: "read",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify that the content-based trigger was activated
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringMatching(
        /<Workflow>[\s\S]*language_context_trigger[\s\S]*<\/Workflow>/
      )
    );

    const emitCall = mockEventService.emit.mock.calls.find(
      (call) => call[0] === "agent:msg"
    );
    expect(emitCall).toBeDefined();

    // Extract JSON from <Workflow> tags
    const workflowContent = emitCall![1].match(/<Workflow>\s*(\{[\s\S]*?\})\s*<\/Workflow>/);
    expect(workflowContent).toBeDefined();
    const eventData = JSON.parse(workflowContent![1]);
    expect(eventData.type).toBe("language_context_trigger");
    expect(eventData.matchingTerms).toContain("test(");
    expect(eventData.contextMessage).toContain("Jest testing best practices");
  });

  test("should not trigger when file content doesn't match", async () => {
    // Mock file content without trigger terms
    const fileContent = `
      const config = {
        database: 'postgresql',
        port: 5432
      };
    `;

    mockedReadFile.mockResolvedValue(Buffer.from(fileContent));
    mockedConfig.mockResolvedValue({
      plugins: [],
      modules: [],
      promptsDir: ".knowhow/prompts",
      sources: [],
      embedSources: [],
      embeddingModel: "text-embedding-ada-002",
      agents: [],
      mcps: [],
      modelProviders: [],
    });
    mockedLanguageConfig.mockResolvedValue({
      "test(": {
        events: ["file:post-read"],
        sources: [{ kind: "text", data: ["Jest testing best practices"] }],
      },
    });

    new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Trigger file:post-read event
    const fileReadHandler = eventHandlers.get("file:post-read");
    expect(fileReadHandler).toBeDefined();

    await fileReadHandler!({
      filePath: "src/config.js",
      operation: "read",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify no trigger was activated
    expect(mockEventService.emit).not.toHaveBeenCalled();
  });

  test("should handle file read errors gracefully", async () => {
    // Mock readFile to throw an error
    mockedReadFile.mockRejectedValue(new Error("File not found"));
    mockedConfig.mockResolvedValue({
      plugins: [],
      modules: [],
      promptsDir: ".knowhow/prompts",
      sources: [],
      embedSources: [],
      embeddingModel: "text-embedding-ada-002",
      agents: [],
      mcps: [],
      modelProviders: [],
    });
    mockedLanguageConfig.mockResolvedValue({
      "test(": {
        events: ["file:post-read"],
        sources: [{ kind: "text", data: ["Jest testing best practices"] }],
      },
    });

    new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Trigger file:post-read event
    const fileReadHandler = eventHandlers.get("file:post-read");
    expect(fileReadHandler).toBeDefined();

    await fileReadHandler!({
      filePath: "src/nonexistent.test.js",
      operation: "read",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify no crash occurred and no trigger was activated
    expect(mockEventService.emit).not.toHaveBeenCalled();
  });

  test("should work with case-insensitive matching", async () => {
    // Mock file content with uppercase TEST
    const fileContent = `
      function myTEST() {
        return true;
      }
    `;

    mockedReadFile.mockResolvedValue(Buffer.from(fileContent));
    mockedConfig.mockResolvedValue({
      plugins: [],
      modules: [],
      promptsDir: ".knowhow/prompts",
      sources: [],
      embedSources: [],
      embeddingModel: "text-embedding-ada-002",
      agents: [],
      mcps: [],
      modelProviders: [],
    });
    mockedLanguageConfig.mockResolvedValue({
      "test(": {
        events: ["file:post-read"],
        sources: [{ kind: "text", data: ["Jest testing best practices"] }],
      },
    });

    new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Trigger file:post-read event
    const fileReadHandler = eventHandlers.get("file:post-read");
    expect(fileReadHandler).toBeDefined();

    await fileReadHandler!({
      filePath: "src/utils.js",
      operation: "read",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify that case-insensitive matching worked
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringMatching(
        /<Workflow>[\s\S]*language_context_trigger[\s\S]*<\/Workflow>/
      )
    );
  });

  test("should trigger on file:post-edit events", async () => {
    const fileContent = `
      test('new test case', () => {
        expect(true).toBe(true);
      });
    `;

    mockedReadFile.mockResolvedValue(Buffer.from(fileContent));
    mockedConfig.mockResolvedValue({
      plugins: [],
      modules: [],
      promptsDir: ".knowhow/prompts",
      sources: [],
      embedSources: [],
      embeddingModel: "text-embedding-ada-002",
      agents: [],
      mcps: [],
      modelProviders: [],
    });
    mockedLanguageConfig.mockResolvedValue({
      "test(": {
        events: ["file:post-read", "file:post-edit"],
        sources: [{ kind: "text", data: ["Jest testing best practices"] }],
      },
    });

    new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Trigger file:post-edit event instead of read
    const fileEditHandler = eventHandlers.get("file:post-edit");
    expect(fileEditHandler).toBeDefined();

    await fileEditHandler!({
      filePath: "src/newFeature.test.js",
      operation: "edit",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify that edit events also trigger content analysis
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringMatching(
        /<Workflow>[\s\S]*language_context_trigger[\s\S]*<\/Workflow>/
      )
    );
  });
});
