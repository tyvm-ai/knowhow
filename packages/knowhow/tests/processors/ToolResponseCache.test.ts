import { Message } from "../../src/clients/types";
import {
  ToolResponseCache,
  jqToolResponseDefinition,
  grepToolResponseDefinition,
  listStoredToolResponsesDefinition,
} from "../../src/processors/ToolResponseCache";
import { ToolsService } from "../../src/services";

// Mock node-jq
jest.mock("node-jq", () => ({
  run: jest
    .fn()
    .mockImplementation(async (query: string, data: any, options: any) => {
      // Simulate common JQ queries based on the test data

      // Handle .test query on {"test": "value"}
      if (query === ".test") {
        if (data && data.test !== undefined) {
          return JSON.stringify(data.test);
        }
      }

      // Handle .id query for extracting id values
      if (query === ".id") {
        return data && data.id !== undefined ? data.id.toString() : "null";
      }

      // Handle .data | length query for counting array elements
      if (query === ".data | length") {
        if (data && Array.isArray(data.data)) {
          return data.data.length.toString();
        }
      }

      // Handle .data | add query for summing array elements
      if (query === ".data | add") {
        if (data && Array.isArray(data.data)) {
          const sum = data.data.reduce((a, b) => a + b, 0);
          return sum.toString();
        }
      }

      // Handle .unicode query for special characters test
      if (query === ".unicode") {
        if (data && data.unicode !== undefined) {
          return JSON.stringify(data.unicode);
        }
      }

      // Handle .empty query for empty string test
      if (query === ".empty") {
        if (data && data.empty !== undefined) {
          return JSON.stringify(data.empty);
        }
      }

      // Handle .nullValue query for null value test
      if (query === ".nullValue") {
        if (data && data.nullValue !== undefined) {
          return JSON.stringify(data.nullValue);
        }
      }

      // Handle .name query on {name: "test", data: [1, 2, 3]}
      if (query === ".name") {
        if (data && data.name) {
          return JSON.stringify(data.name);
        }
      }

      // Handle .data[] query on {name: "test", data: [1, 2, 3]}
      if (query === ".data[]") {
        if (data && Array.isArray(data.data)) {
          return data.data.join("\n");
        }
      }

      // Handle map(.value) on [{id: 1, value: "a"}, {id: 2, value: "b"}]
      if (query === "map(.value)") {
        if (Array.isArray(data)) {
          const values = data.map((item) => item.value);
          return JSON.stringify(values);
        }
      }

      // Handle map({identifier: .id, content: .value}) transformation
      if (query === "map({identifier: .id, content: .value})") {
        if (Array.isArray(data)) {
          const transformed = data.map((item) => ({
            identifier: item.id,
            content: item.value,
          }));
          return JSON.stringify(transformed);
        }
      }

      // Handle "." query (return entire object, formatted)
      if (query === ".") {
        return JSON.stringify(data, null, 2);
      }

      // Handle .nested.inner query for nested JSON
      if (query === ".nested.inner") {
        if (data && data.nested && data.nested.inner) {
          return JSON.stringify(data.nested.inner);
        }
      }

      // Handle map(select(.id > 10)) - empty result
      if (query === "map(select(.id > 10))") {
        return JSON.stringify([]);
      }

      // Handle invalid queries - throw error
      if (query === ".invalid[") {
        throw new Error("Invalid JQ query syntax");
      }

      // Handle deep nested queries
      if (query === ".level1.level2.level3.level4.level5.deepValue") {
        if (
          data &&
          data.level1 &&
          data.level1.level2 &&
          data.level1.level2.level3 &&
          data.level1.level2.level3.level4 &&
          data.level1.level2.level3.level4.level5
        ) {
          return JSON.stringify(
            data.level1.level2.level3.level4.level5.deepValue
          );
        }
      }

      // Handle queries on invalid JSON data
      if (typeof data === "string" && data === "invalid json string") {
        throw new Error("Invalid JSON input");
      }

      // Default fallback - return stringified data
      try {
        return JSON.stringify(data);
      } catch (error) {
        throw new Error(`JQ query failed: ${error}`);
      }
    }),
}));

const mockJq = require("node-jq");

describe("ToolResponseCache", () => {
  let cache: ToolResponseCache;
  let mockToolsService: jest.Mocked<ToolsService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockToolsService = {
      addTools: jest.fn(),
      addFunctions: jest.fn(),
      getTool: jest.fn().mockReturnValue(undefined),
      callTool: jest.fn(),
    } as any;

    cache = new ToolResponseCache(mockToolsService);
  });

  describe("constructor", () => {
    it("should create an instance and register tool with ToolsService", () => {
      expect(cache).toBeDefined();
      expect(cache).toBeInstanceOf(ToolResponseCache);
      expect(mockToolsService.addTools).toHaveBeenCalledWith([
        jqToolResponseDefinition,
        grepToolResponseDefinition,
        listStoredToolResponsesDefinition,
      ]);
      expect(mockToolsService.addFunctions).toHaveBeenCalledWith({
        jqToolResponse: expect.any(Function),
        grepToolResponse: expect.any(Function),
        listStoredToolResponses: expect.any(Function),
      });
    });

    it("should overwrite tool if it already exists", () => {
      mockToolsService.getTool.mockReturnValue(jqToolResponseDefinition);
      const newCache = new ToolResponseCache(mockToolsService);

      // Should be called each time
      expect(mockToolsService.addTools).toHaveBeenCalledTimes(2);
    });
  });

  describe("createProcessor", () => {
    it("should create a message processor function", () => {
      const processor = cache.createProcessor();
      expect(typeof processor).toBe("function");
    });

    it("should process tool response messages", async () => {
      const processor = cache.createProcessor();

      const messages: Message[] = [
        {
          role: "tool",
          tool_call_id: "call_123",
          content: '{"data": [{"name": "test", "value": 42}]}',
        },
      ];

      await processor(messages, messages);

      // Verify message was stored
      expect(cache.getStorageKeys()).toContain("call_123");
      expect(cache.retrieveRawResponse("call_123")).toBe(
        '{"data": [{"name": "test", "value": 42}]}'
      );
    });

    it("should ignore non-tool messages", async () => {
      const processor = cache.createProcessor();

      const messages: Message[] = [
        {
          role: "user",
          content: "This is a user message",
        },
        {
          role: "assistant",
          content: "This is an assistant message",
        },
      ];

      await processor(messages, messages);

      expect(cache.getStorageSize()).toBe(0);
    });
    it("should ignore tool messages without tool_call_id", async () => {
      const processor = cache.createProcessor();

      const messages: Message[] = [
        {
          role: "tool",
          content: "Tool response without call ID",
        } as Message,
      ];

      await processor(messages, messages);

      expect(cache.getStorageSize()).toBe(0);
    });

    it("should ignore tool messages with non-string content", async () => {
      const processor = cache.createProcessor();

      const messages: Message[] = [
        {
          role: "tool",
          tool_call_id: "call_123",
          content: null,
        } as Message,
        {
          role: "tool",
          tool_call_id: "call_456",
          content: undefined,
        } as Message,
        {
          role: "tool",
          tool_call_id: "call_789",
          content: 42 as any,
        } as Message,
      ];

      await processor(messages, messages);

      expect(cache.getStorageSize()).toBe(0);
    });

    it("should apply filter function when provided", async () => {
      const filterFn = (msg: Message) => msg.tool_call_id === "call_allowed";
      const processor = cache.createProcessor(filterFn);

      const messages: Message[] = [
        {
          role: "tool",
          tool_call_id: "call_allowed",
          content: "Allowed content",
        },
        {
          role: "tool",
          tool_call_id: "call_blocked",
          content: "Blocked content",
        },
      ];

      await processor(messages, messages);

      expect(cache.getStorageKeys()).toContain("call_allowed");
      expect(cache.getStorageKeys()).not.toContain("call_blocked");
      expect(cache.getStorageSize()).toBe(1);
    });
  });

  describe("storeToolResponse", () => {
    it("should store tool response content with metadata", () => {
      const content = '{"test": "data"}';
      const toolCallId = "call_123";

      // Access private method for testing
      (cache as any).storeToolResponse(content, toolCallId);

      expect(cache.retrieveRawResponse(toolCallId)).toBe(content);
      expect(cache.getStorageKeys()).toContain(toolCallId);

      // Check metadata
      const metadata = (cache as any).metadataStorage[toolCallId];
      expect(metadata.toolCallId).toBe(toolCallId);
      expect(metadata.originalLength).toBe(content.length);
      expect(metadata.storedAt).toBeGreaterThan(0);
    });
  });
  describe("queryToolResponse", () => {
    beforeEach(() => {
      // Store some test data
      cache.storeToolResponse(
        '{"name": "test", "data": [1, 2, 3]}',
        "call_123"
      );
      cache.storeToolResponse(
        '[{"id": 1, "value": "a"}, {"id": 2, "value": "b"}]',
        "call_456"
      );
      cache.storeToolResponse(
        '{"nested": "{\\"inner\\": \\"value\\"}"}',
        "call_789"
      );
      cache.storeToolResponse("invalid json string", "call_invalid");
    });

    it("should execute simple JQ queries successfully", async () => {
      const result = await cache.queryToolResponse("call_123", ".name");
      expect(result).toBe('"test"');
    });

    it("should execute array queries", async () => {
      const result = await cache.queryToolResponse("call_123", ".data[]");
      expect(result).toBe("1\n2\n3");
    });

    it("should execute complex JQ queries", async () => {
      const result = await cache.queryToolResponse("call_456", "map(.value)");
      expect(result).toBe('["a","b"]');
    });

    it("should handle object transformation queries", async () => {
      const result = await cache.queryToolResponse(
        "call_456",
        "map({identifier: .id, content: .value})"
      );
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([
        { identifier: 1, content: "a" },
        { identifier: 2, content: "b" },
      ]);
    });

    it("should return error for missing tool call ID", async () => {
      const result = await cache.queryToolResponse("missing_id", ".test");
      expect(result).toContain("Error: No tool response found");
      expect(result).toContain("missing_id");
      expect(result).toContain("Available IDs:");
    });

    it("should handle invalid JQ queries with error message", async () => {
      const result = await cache.queryToolResponse("call_123", ".invalid[");
      expect(result).toContain("JQ Query Error:");
    });

    it("should handle non-JSON data with helpful error", async () => {
      const result = await cache.queryToolResponse("call_invalid", ".test");
      expect(result).toContain("Error: Tool response data is not valid JSON");
      expect(result).toContain('toolCallId "call_invalid"');
    });

    it("should return formatted JSON for complex results", async () => {
      const result = await cache.queryToolResponse("call_456", ".");
      expect(result).toContain("[\n");
      expect(result).toContain("  {");
      expect(result).toContain('    "id":');
    });

    it("should handle nested JSON strings parsing", async () => {
      const result = await cache.queryToolResponse("call_789", ".nested.inner");
      expect(result).toBe('"value"');
    });

    it("should handle empty query results", async () => {
      const result = await cache.queryToolResponse(
        "call_456",
        "map(select(.id > 10))"
      );
      expect(result).toBe("[]");
    });
  });

  describe("parseNestedJsonStrings", () => {
    it("should parse simple JSON strings", () => {
      const input = '{"test": "value"}';
      const result = cache.parseNestedJsonStrings(input);
      expect(result).toEqual({ test: "value" });
    });

    it("should parse nested JSON strings recursively", () => {
      const input = '{"outer": "{\\"inner\\": \\"value\\"}"}';
      const result = cache.parseNestedJsonStrings(input);
      expect(result).toEqual({
        outer: { inner: "value" },
      });
    });

    it("should handle arrays with JSON strings", () => {
      const input = ['{"test": "value1"}', '{"test": "value2"}'];
      const result = cache.parseNestedJsonStrings(input);
      expect(result).toEqual([{ test: "value1" }, { test: "value2" }]);
    });

    it("should handle mixed nested structures", () => {
      const input = {
        stringField: '{"nested": "value"}',
        arrayField: ['{"item": 1}', '{"item": 2}'],
        objectField: {
          deepString: '{"deep": "nested"}',
        },
      };
      const result = cache.parseNestedJsonStrings(input);
      expect(result).toEqual({
        stringField: { nested: "value" },
        arrayField: [{ item: 1 }, { item: 2 }],
        objectField: {
          deepString: { deep: "nested" },
        },
      });
    });

    it("should leave non-JSON strings unchanged", () => {
      const input = {
        jsonString: '{"test": "value"}',
        regularString: "just a string",
        number: 42,
        boolean: true,
      };
      const result = cache.parseNestedJsonStrings(input);
      expect(result).toEqual({
        jsonString: { test: "value" },
        regularString: "just a string",
        number: 42,
        boolean: true,
      });
    });

    it("should handle malformed JSON strings gracefully", () => {
      const input = '{"invalid": json}';
      const result = cache.parseNestedJsonStrings(input);
      expect(result).toBe(input); // Should return original string
    });
  });
  describe("retrieveRawResponse", () => {
    it("should return stored raw content", () => {
      const content = '{"test": "data"}';
      cache.storeToolResponse(content, "call_123");

      const result = cache.retrieveRawResponse("call_123");
      expect(result).toBe(content);
    });

    it("should return null for missing tool call ID", () => {
      const result = cache.retrieveRawResponse("missing_id");
      expect(result).toBeNull();
    });
  });

  describe("clearStorage", () => {
    it("should clear all stored data and metadata", () => {
      cache.storeToolResponse('{"test": "data"}', "call_123");
      cache.storeToolResponse('{"more": "data"}', "call_456");

      expect(cache.getStorageSize()).toBe(2);

      cache.clearStorage();

      expect(cache.getStorageSize()).toBe(0);
      expect(cache.getStorageKeys()).toEqual([]);
      expect(cache.retrieveRawResponse("call_123")).toBeNull();
      expect(cache.retrieveRawResponse("call_456")).toBeNull();
    });
  });

  describe("getStorageKeys", () => {
    it("should return empty array when no data stored", () => {
      expect(cache.getStorageKeys()).toEqual([]);
    });

    it("should return all stored tool call IDs", () => {
      cache.storeToolResponse('{"test": "data1"}', "call_123");
      cache.storeToolResponse('{"test": "data2"}', "call_456");
      cache.storeToolResponse('{"test": "data3"}', "call_789");

      const keys = cache.getStorageKeys();
      expect(keys).toContain("call_123");
      expect(keys).toContain("call_456");
      expect(keys).toContain("call_789");
      expect(keys).toHaveLength(3);
    });
  });

  describe("getStorageSize", () => {
    it("should return 0 for empty storage", () => {
      expect(cache.getStorageSize()).toBe(0);
    });

    it("should return correct count after storing responses", () => {
      expect(cache.getStorageSize()).toBe(0);

      cache.storeToolResponse('{"test": "data1"}', "call_123");
      expect(cache.getStorageSize()).toBe(1);

      cache.storeToolResponse('{"test": "data2"}', "call_456");
      expect(cache.getStorageSize()).toBe(2);

      cache.clearStorage();
      expect(cache.getStorageSize()).toBe(0);
    });
  });

  describe("registerTool", () => {
    let mockToolsService: jest.Mocked<ToolsService>;

    beforeEach(() => {
      mockToolsService = {
        getTool: jest.fn(),
        addTools: jest.fn(),
        addFunctions: jest.fn(),
      } as any;
    });

    it("should register tool when not already present", () => {
      mockToolsService.getTool.mockReturnValue(null);

      cache.registerTool(mockToolsService);

      expect(mockToolsService.addTools).toHaveBeenCalledWith([
        {
          type: "function",
          function: expect.objectContaining({
            name: "jqToolResponse",
          }),
        },
        {
          type: "function",
          function: expect.objectContaining({
            name: "grepToolResponse",
          }),
        },
        {
          type: "function",
          function: expect.objectContaining({
            name: "listStoredToolResponses",
          }),
        },
      ]);
      expect(mockToolsService.addFunctions).toHaveBeenCalledWith({
        jqToolResponse: expect.any(Function),
        grepToolResponse: expect.any(Function),
        listStoredToolResponses: expect.any(Function),
      });
    });

    it("should overwrite tool when already present", () => {
      mockToolsService.getTool.mockReturnValue({} as any);

      cache.registerTool(mockToolsService);

      expect(mockToolsService.addTools).toHaveBeenCalled();
      expect(mockToolsService.addFunctions).toHaveBeenCalled();
    });

    it("should register function that calls queryToolResponse", async () => {
      mockToolsService.getTool.mockReturnValue(null);

      cache.registerTool(mockToolsService);

      const addFunctionsCall = mockToolsService.addFunctions.mock.calls[0][0];
      const jqFunction = addFunctionsCall.jqToolResponse;

      // Store test data
      cache.storeToolResponse('{"test": "value"}', "call_123");

      // Test the registered function
      const result = await jqFunction("call_123", ".test");
      expect(result).toBe('"value"');
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle very large JSON objects", async () => {
      const largeObject = {
        data: Array(1000)
          .fill(0)
          .map((_, i) => ({
            id: i,
            name: `item_${i}`,
            description: `This is item number ${i} with some additional text to make it larger`,
          })),
      };
      const largeContent = JSON.stringify(largeObject);

      cache.storeToolResponse(largeContent, "call_large");

      const result = await cache.queryToolResponse(
        "call_large",
        ".data | length"
      );
      expect(result).toBe("1000");
    });

    it("should handle special characters in JSON", async () => {
      const specialContent = JSON.stringify({
        unicode: "Hello 世界 🌍",
        escaped: "Line 1\nLine 2\tTabbed",
        quotes: 'He said "Hello" to me',
      });

      cache.storeToolResponse(specialContent, "call_special");

      const result = await cache.queryToolResponse("call_special", ".unicode");
      expect(result).toBe('"Hello 世界 🌍"');
    });

    it("should handle empty strings and null values", async () => {
      const content = JSON.stringify({
        empty: "",
        nullValue: null,
        zero: 0,
        false: false,
      });

      cache.storeToolResponse(content, "call_empty");

      const emptyResult = await cache.queryToolResponse("call_empty", ".empty");
      expect(emptyResult).toBe('""');

      const nullResult = await cache.queryToolResponse(
        "call_empty",
        ".nullValue"
      );
      expect(nullResult).toBe("null");
    });

    it("should handle concurrent storage operations", async () => {
      const promises = Array(10)
        .fill(0)
        .map((_, i) =>
          Promise.resolve(cache.storeToolResponse(`{"id": ${i}}`, `call_${i}`))
        );

      await Promise.all(promises);

      expect(cache.getStorageSize()).toBe(10);

      const results = await Promise.all(
        Array(10)
          .fill(0)
          .map((_, i) => cache.queryToolResponse(`call_${i}`, ".id"))
      );

      results.forEach((result, i) => {
        expect(result).toBe(i.toString());
      });
    });

    it("should handle deeply nested JSON structures", async () => {
      const deepObject = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  deepValue: "found it!",
                },
              },
            },
          },
        },
      };

      cache.storeToolResponse(JSON.stringify(deepObject), "call_deep");

      const result = await cache.queryToolResponse(
        "call_deep",
        ".level1.level2.level3.level4.level5.deepValue"
      );
      expect(result).toBe('"found it!"');
    });
  });

  describe("Integration with Message Processing", () => {
    it("should integrate with complete message processing workflow", async () => {
      const processor = cache.createProcessor();

      const messages: Message[] = [
        {
          role: "user",
          content: "Test request",
        },
        {
          role: "assistant",
          content: "Processing...",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "testTool",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: JSON.stringify({
            result: "success",
            data: [1, 2, 3, 4, 5],
          }),
        },
      ];

      await processor(messages, messages);

      expect(cache.getStorageSize()).toBe(1);

      const result = await cache.queryToolResponse(
        "call_123",
        ".data | length"
      );
      expect(result).toBe("5");

      const sumResult = await cache.queryToolResponse(
        "call_123",
        ".data | add"
      );
      expect(result).toBe("5");
    });
  });
});
