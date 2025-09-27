jest.mock("../../../src/utils", () => ({
  readFile: jest.fn(),
  fileExists: jest.fn().mockReturnValue(true),
  fileStat: jest.fn(),
}));

jest.mock("../../../src/config", () => ({
  getConfig: jest.fn(),
  getLanguageConfig: jest.fn(),
  updateLanguageConfig: jest.fn(),
}));

jest.mock("../../../src/plugins/plugins", () => ({
  PluginService: jest.fn().mockImplementation(() => ({
    listPlugins: jest.fn().mockReturnValue([]),
    call: jest.fn().mockResolvedValue([]),
  })),
}));

import { LanguagePlugin } from "../../../src/plugins/language";
import {
  getConfig,
  getLanguageConfig,
  updateLanguageConfig,
} from "../../../src/config";
import { PluginService } from "../../../src/plugins/plugins";
import * as utils from "../../../src/utils";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import { Config } from "../../../src/types";

describe("LanguagePlugin - Integration Tests", () => {
  let plugin: LanguagePlugin;
  let tempDir: string;
  let tempFile: string;
  let mockEventService: any;
  let mockPluginService: any;

  beforeEach(async () => {
    // Create a temporary directory and file for integration tests
    tempDir = path.join(tmpdir(), "languageplugin-test-" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    tempFile = path.join(tempDir, "test-file.ts");

    // Mock services
    mockEventService = {
      on: jest.fn(),
      emit: jest.fn(),
    };

    mockPluginService = new (PluginService as jest.MockedClass<
      typeof PluginService
    >)({} as any);
    mockPluginService.listPlugins = jest.fn().mockReturnValue([]);
    mockPluginService.call = jest.fn().mockResolvedValue([]);

    // Mock config functions
    (getConfig as jest.MockedFunction<typeof getConfig>).mockResolvedValue({
      plugins: [],
    } as Config);

    // Setup language configuration with testing term
    (
      getLanguageConfig as jest.MockedFunction<typeof getLanguageConfig>
    ).mockResolvedValue({
      "test(": {
        events: ["file:post-read", "file:post-edit"],
        sources: [
          {
            kind: "text",
            data: ["Testing context: This is test-related information"],
          },
        ],
      },
    });

    // Mock utils.readFile to return file contents
    (
      utils.readFile as jest.MockedFunction<typeof utils.readFile>
    ).mockImplementation((filePath: string) => {
      if (fs.existsSync(filePath)) {
        return Promise.resolve(fs.readFileSync(filePath));
      }
      return Promise.reject(new Error("File not found"));
    });

    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);
  });

  afterEach(() => {
    // Clean up temporary files
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  test("should trigger when reading real files with test content", async () => {
    // Write test content to a real file
    const testContent = `
function calculateSum(a: number, b: number): number {
  return a + b;
}

test("should calculate sum correctly", () => {
  expect(calculateSum(2, 3)).toBe(5);
});
`;
    fs.writeFileSync(tempFile, testContent);

    // Get the event handler that was registered
    const eventHandlers = new Map();
    mockEventService.on.mockImplementation(
      (event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }
    );

    // Recreate plugin to register handlers
    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    // Wait for async setupEventHandlers to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate file:post-read event with real file
    const fileReadHandler = eventHandlers.get("file:post-read");
    if (fileReadHandler) {
      await fileReadHandler({
        filePath: tempFile,
        fileContent: fs.readFileSync(tempFile),
      });
    }

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify agent:msg was emitted
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringContaining("language_context_trigger")
    );
  });

  test("should work with readFile tool simulation", async () => {
    // Write test content with various test patterns
    const testContent = `
import { describe, it, expect } from 'vitest';

describe('User service', () => {
  it('should create user', async () => {
    const user = await createUser({ name: 'John' });
    expect(user.id).toBeDefined();
  });

  test('should validate email', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
  });
});
`;
    fs.writeFileSync(tempFile, testContent);

    // Setup event handlers
    const eventHandlers = new Map();
    mockEventService.on.mockImplementation(
      (event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }
    );

    // Recreate plugin to register handlers
    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate readFile tool being used
    const fileReadHandler = eventHandlers.get("file:post-read");
    if (fileReadHandler) {
      await fileReadHandler({
        filePath: tempFile,
        fileContent: fs.readFileSync(tempFile),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should trigger on 'test(' pattern
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringContaining("Testing context")
    );
  });

  test("should work with file editing scenarios", async () => {
    // Initial file without test content
    const initialContent = `
function getUserData(id: string) {
  return database.find(id);
}
`;
    fs.writeFileSync(tempFile, initialContent);

    // Setup event handlers
    const eventHandlers = new Map();
    mockEventService.on.mockImplementation(
      (event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }
    );

    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate initial read - should not trigger
    const fileReadHandler = eventHandlers.get("file:post-read");
    if (fileReadHandler) {
      await fileReadHandler({
        filePath: tempFile,
        fileContent: fs.readFileSync(tempFile),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockEventService.emit).not.toHaveBeenCalled();

    // Now edit file to add test content
    const editedContent =
      initialContent +
      `

test('should get user data', () => {
  const result = getUserData('123');
  expect(result).toBeDefined();
});
`;
    fs.writeFileSync(tempFile, editedContent);

    // Reset mock
    mockEventService.emit.mockClear();

    // Simulate file:post-edit event
    const fileEditHandler = eventHandlers.get("file:post-edit");
    if (fileEditHandler) {
      await fileEditHandler({
        filePath: tempFile,
        fileContent: fs.readFileSync(tempFile),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should now trigger on the edited content
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringContaining("Testing context")
    );
  });

  test("should handle multiple language terms in same file", async () => {
    // Update language config with multiple terms
    (
      getLanguageConfig as jest.MockedFunction<typeof getLanguageConfig>
    ).mockResolvedValue({
      "test(": {
        events: ["file:post-read"],
        sources: [
          {
            kind: "text",
            data: ["Testing context: This is test-related information"],
          },
        ],
      },
      database: {
        events: ["file:post-read"],
        sources: [
          {
            kind: "text",
            data: ["Database context: Connection and query information"],
          },
        ],
      },
    });

    // Write content that matches both terms
    const testContent = `
import { database } from './db';

test('should query database correctly', async () => {
  const result = await database.query('SELECT * FROM users');
  expect(result.length).toBeGreaterThan(0);
});
`;
    fs.writeFileSync(tempFile, testContent);

    // Setup event handlers
    const eventHandlers = new Map();
    mockEventService.on.mockImplementation(
      (event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }
    );

    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate file read
    const fileReadHandler = eventHandlers.get("file:post-read");
    if (fileReadHandler) {
      await fileReadHandler({
        filePath: tempFile,
        fileContent: fs.readFileSync(tempFile),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should emit agent:msg for the triggered terms
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringContaining("language_context_trigger")
    );

    // Check that the emitted message contains both contexts
    const emitCalls = mockEventService.emit.mock.calls.filter(
      (call) => call[0] === "agent:msg"
    );
    expect(emitCalls.length).toBeGreaterThan(0);

    const eventData = JSON.parse(emitCalls[0][1]);
    expect(eventData.matchingTerms).toEqual(
      expect.arrayContaining(["test(", "database"])
    );
  });

  test("should work with different file extensions", async () => {
    // Test with .js file
    const jsFile = path.join(tempDir, "test-file.js");
    const jsContent = `
function sum(a, b) {
  return a + b;
}

test('sum function works', () => {
  expect(sum(1, 2)).toBe(3);
});
`;
    fs.writeFileSync(jsFile, jsContent);

    // Setup event handlers
    const eventHandlers = new Map();
    mockEventService.on.mockImplementation(
      (event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }
    );

    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate file read
    const fileReadHandler = eventHandlers.get("file:post-read");
    if (fileReadHandler) {
      await fileReadHandler({
        filePath: jsFile,
        fileContent: fs.readFileSync(jsFile),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringContaining("Testing context")
    );

    // Clean up
    fs.unlinkSync(jsFile);
  });

  test("should handle large files efficiently", async () => {
    // Create a larger file with test content
    let largeContent = "// Large file for performance testing\n";
    for (let i = 0; i < 1000; i++) {
      largeContent += `function helper${i}() { return ${i}; }\n`;
    }
    largeContent += `
test('performance test', () => {
  expect(helper999()).toBe(999);
});
`;

    fs.writeFileSync(tempFile, largeContent);

    // Setup event handlers
    const eventHandlers = new Map();
    mockEventService.on.mockImplementation(
      (event: string, handler: Function) => {
        eventHandlers.set(event, handler);
      }
    );

    plugin = new LanguagePlugin({
      Events: mockEventService,
      Plugins: mockPluginService,
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const startTime = Date.now();

    // Simulate file read
    const fileReadHandler = eventHandlers.get("file:post-read");
    if (fileReadHandler) {
      await fileReadHandler({
        filePath: tempFile,
        fileContent: fs.readFileSync(tempFile),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const processingTime = Date.now() - startTime;

    // Should still trigger correctly
    expect(mockEventService.emit).toHaveBeenCalledWith(
      "agent:msg",
      expect.stringContaining("Testing context")
    );

    // Should process reasonably quickly (less than 1 second)
    expect(processingTime).toBeLessThan(1000);
  });
});
