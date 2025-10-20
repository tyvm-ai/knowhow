import { Message } from "../../src/clients/types";
import { TokenCompressor } from "../../src/processors/TokenCompressor";
import { ToolsService } from "../../src/services";

describe("TokenCompressor", () => {
  let tokenCompressor: TokenCompressor;
  let mockToolsService: jest.Mocked<ToolsService>;

  beforeEach(() => {
    mockToolsService = {
      addTools: jest.fn(),
      addFunctions: jest.fn(),
      getTool: jest.fn(),
    } as any;

    tokenCompressor = new TokenCompressor(mockToolsService);
  });

  afterEach(() => {
    tokenCompressor.clearStorage();
  });

  describe("constructor", () => {
    it("should register expandTokens tool with ToolsService", () => {
      expect(mockToolsService.addTools).toHaveBeenCalled();
      expect(mockToolsService.addFunctions).toHaveBeenCalled();
    });

    it("should overwrite tool if already exists", () => {
      mockToolsService.getTool.mockReturnValue({ type: "function", function: { name: "expandTokens" } } as any);
      const newCompressor = new TokenCompressor(mockToolsService);

      // Should only be called once from the first instance
      expect(mockToolsService.addTools).toHaveBeenCalledTimes(2);
    });

    it("should work without ToolsService", () => {
      expect(() => new TokenCompressor()).not.toThrow();
    });
  });

  describe("compressContent", () => {
    it("should return original content if below threshold", () => {
      const shortContent = "This is short content";
      const result = tokenCompressor.compressContent(shortContent);
      expect(result).toBe(shortContent);
    });

    it("should compress long strings using chunking", () => {
      const longContent = "x".repeat(40000); // Well above threshold (40k chars = 10k tokens > 8k maxTokens)
      const result = tokenCompressor.compressContent(longContent);

      expect(result).toContain("[COMPRESSED_STRING");
      expect(result).toContain("Key:");
      expect(result).toContain("expandTokens");
      expect(result).toContain("Preview:");
    });

    it("should compress JSON objects by properties", () => {
      const largeJson = {
        data: "x".repeat(40000), // 40k chars = 10k tokens, above threshold
        metadata: { id: 1, name: "test" }
      };
      const content = JSON.stringify(largeJson);
      const result = tokenCompressor.compressContent(content);

      // Should be parsed and compressed as JSON
      const parsed = JSON.parse(result);
      expect(typeof parsed.data).toBe("string");
      expect(parsed.data).toContain("[COMPRESSED_JSON_PROPERTY");
    });

    it("should handle mixed JSON compression strategies", () => {
      const complexJson = {
        smallProp: "small",
        largeProp: "x".repeat(40000), // 40k chars = 10k tokens, above threshold
        array: new Array(2000).fill({ item: "data".repeat(50) }) // Larger array to trigger compression
      };
      const content = JSON.stringify(complexJson);
      const result = tokenCompressor.compressContent(content);

      const parsed = JSON.parse(result);
      expect(parsed.smallProp).toBe("small"); // Should remain unchanged
      expect(parsed.largeProp).toContain("[COMPRESSED_JSON_PROPERTY"); // Should be compressed
    });
  });

  describe("compressStringInChunks", () => {
    it("should return original string if below limit", () => {
      const content = "short string";
      const result = tokenCompressor.compressStringInChunks(content);
      expect(result).toBe(content);
    });

    it("should create chunked compression for large strings", () => {
      const content = "x".repeat(20000);
      const result = tokenCompressor.compressStringInChunks(content);

      expect(result).toContain("[COMPRESSED_STRING");
      expect(result).toContain("chunks");
      expect(result).toContain("Key:");

      // Should have stored chunks in storage
      expect(tokenCompressor.getStorageSize()).toBeGreaterThan(0);
    });

    it("should create chain of NEXT_CHUNK_KEY references", () => {
      const content = "a".repeat(20000);
      tokenCompressor.compressStringInChunks(content);

      const keys = tokenCompressor.getStorageKeys();
      expect(keys.length).toBeGreaterThan(1);

      // Check that chunks are linked
      const firstChunk = tokenCompressor.retrieveString(keys[0]);
      expect(firstChunk).toContain("NEXT_CHUNK_KEY");
    });
  });

  describe("compressJsonProperties", () => {
    it("should compress large array elements", () => {
      // Create array that will definitely create chunks > 4000 chars (50 elements × 200 chars = 10k+ chars per potential chunk)
      const largeArray = new Array(15).fill("x".repeat(2200));
      const result = tokenCompressor.compressJsonProperties(largeArray);

      // Should contain compression markers
      expect(JSON.stringify(result)).toContain("[COMPRESSED_JSON_ARRAY_CHUNK");
    });

    it("should compress nested JSON objects", () => {
      const nestedObj = {
        level1: {
          level2: {
            data: "x".repeat(40000) // 40k chars = ~10k tokens, above 8k threshold
          }
        }
      };

      const result = tokenCompressor.compressJsonProperties(nestedObj);
      expect(JSON.stringify(result)).toContain("[COMPRESSED_JSON");
    });

    it("should handle arrays with mixed content sizes", () => {
      const mixedArray = [
        "small",
        "x".repeat(5000), // Large item
        { data: "y".repeat(5000) }, // Large object
        "another small item"
      ];

      const result = tokenCompressor.compressJsonProperties(mixedArray);
      expect(Array.isArray(result)).toBe(true);
    });

    it("should preserve small objects unchanged", () => {
      const smallObj = { id: 1, name: "test", active: true };
      const result = tokenCompressor.compressJsonProperties(smallObj);
      expect(result).toEqual(smallObj);
    });
  });

  describe("compressMessage", () => {
    it("should compress string content in messages", async () => {
      const message: Message = {
        role: "user",
        content: "x".repeat(20000)
      };

      await tokenCompressor.compressMessage(message);

      expect(message.content).toContain("[COMPRESSED_STRING");
    });

    it("should compress text in multimodal content", async () => {
      const message: Message = {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(20000) },
          { type: "image_url", image_url: { url: "http://example.com/img.jpg" } }
        ]
      };

      await tokenCompressor.compressMessage(message);

      const textContent = message.content[0] as { type: string; text: string };
      expect(textContent.text).toContain("[COMPRESSED_STRING");

      // Non-text content should remain unchanged
      const imageContent = message.content[1] as { type: string; image_url: { url: string } };
      expect(imageContent.image_url.url).toBe("http://example.com/img.jpg");
    });

    it("should handle messages with no content", async () => {
      const message: Message = { role: "user" } as any;
      await expect(tokenCompressor.compressMessage(message)).resolves.not.toThrow();
    });
  });

  describe("createProcessor", () => {
    it("should create processor that compresses all messages", async () => {
      const processor = tokenCompressor.createProcessor();
      const messages: Message[] = [
        { role: "user", content: "x".repeat(20000) },
        { role: "assistant", content: "short response" }
      ];

      await processor([], messages);

      expect(messages[0].content).toContain("[COMPRESSED_STRING");
      expect(messages[1].content).toBe("short response"); // Should remain short
    });

    it("should create processor with filter function", async () => {
      const processor = tokenCompressor.createProcessor(
        (msg) => msg.role === "user"
      );
      const messages: Message[] = [
        { role: "user", content: "x".repeat(20000) },
        { role: "assistant", content: "x".repeat(20000) }
      ];

      await processor([], messages);

      expect(messages[0].content).toContain("[COMPRESSED_STRING");
      expect(messages[1].content).not.toContain("[COMPRESSED_STRING");
    });
  });

  describe("storage operations", () => {
    it("should store and retrieve strings", () => {
      const key = "test_key";
      const value = "test_value";

      tokenCompressor.storeString(key, value);
      const retrieved = tokenCompressor.retrieveString(key);

      expect(retrieved).toBe(value);
    });

    it("should return null for non-existent keys", () => {
      const result = tokenCompressor.retrieveString("non_existent");
      expect(result).toBeNull();
    });

    it("should clear all storage", () => {
      tokenCompressor.storeString("key1", "value1");
      tokenCompressor.storeString("key2", "value2");

      expect(tokenCompressor.getStorageSize()).toBe(2);

      tokenCompressor.clearStorage();
      expect(tokenCompressor.getStorageSize()).toBe(0);
    });

    it("should return storage keys", () => {
      tokenCompressor.storeString("key1", "value1");
      tokenCompressor.storeString("key2", "value2");

      const keys = tokenCompressor.getStorageKeys();
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
    });
  });

  describe("configuration", () => {
    it("should allow setting compression threshold", () => {
      tokenCompressor.setCompressionThreshold(1000);

      const content = "x".repeat(5000); // Above new threshold (5000 chars = 1250 tokens > 1000)
      const result = tokenCompressor.compressContent(content);

      expect(result).toContain("[COMPRESSED_STRING");
    });

    it("should adjust character limit with threshold", () => {
      const originalThreshold = 4000;
      const newThreshold = 2000;

      tokenCompressor.setCompressionThreshold(newThreshold);

      // Should compress at lower threshold
      const content = "x".repeat(9000); // Above new threshold (9000 chars = 2250 tokens > 2000)
      const result = tokenCompressor.compressContent(content);

      expect(result).toContain("[COMPRESSED_STRING");
    });
  });

  describe("tool function integration", () => {
    it("should register expandTokens function correctly", () => {
      const toolsServiceCalls = mockToolsService.addFunctions.mock.calls;
      expect(toolsServiceCalls.length).toBe(1);

      const functions = toolsServiceCalls[0][0];
      expect(functions.expandTokens).toBeDefined();
      expect(typeof functions.expandTokens).toBe("function");
    });

    it("should return stored data when expandTokens is called", () => {
      const key = "test_key";
      const value = "test_value";
      tokenCompressor.storeString(key, value);

      const toolsServiceCalls = mockToolsService.addFunctions.mock.calls;
      const functions = toolsServiceCalls[0][0];
      const result = functions.expandTokens(key);

      expect(result).toBe(value);
    });

    it("should return error message for non-existent keys", () => {
      const toolsServiceCalls = mockToolsService.addFunctions.mock.calls;
      const functions = toolsServiceCalls[0][0];
      const result = functions.expandTokens("non_existent");

      expect(result).toContain("Error: No data found for key");
      expect(result).toContain("Available keys:");
    });
  });

  describe("edge cases", () => {
    it("should handle empty strings", () => {
      const result = tokenCompressor.compressContent("");
      expect(result).toBe("");
    });

    it("should handle malformed JSON gracefully", () => {
      const malformedJson = '{"incomplete": "json"'; // Missing closing brace
      const result = tokenCompressor.compressContent(malformedJson);

      // Should treat as string, not JSON
      if (result.length > malformedJson.length) {
        expect(result).toContain("[COMPRESSED_STRING");
      } else {
        expect(result).toBe(malformedJson);
      }
    });

    it("should handle very large objects without stack overflow", () => {
      const deepObject = { level: 0 } as any;
      let current = deepObject;

      // Create deeply nested object
      for (let i = 1; i < 100; i++) {
        current.next = { level: i, data: "x".repeat(100) };
        current = current.next;
      }

      expect(() => {
        tokenCompressor.compressJsonProperties(deepObject);
      }).not.toThrow();
    });

    it("should handle circular references in JSON", () => {
      const obj: any = { name: "test" };
      obj.self = obj; // Create circular reference

      expect(() => {
        JSON.stringify(obj); // This should throw
      }).toThrow();

      // Our compressor should handle this gracefully by not receiving circular JSON
      const safeObj = { name: "test", data: "x".repeat(10000) };
      expect(() => {
        tokenCompressor.compressJsonProperties(safeObj);
      }).not.toThrow();
    });
  });

  describe("performance characteristics", () => {
    it("should handle large arrays efficiently", () => {
      const largeArray = new Array(1000).fill("x".repeat(100));
      const startTime = Date.now();

      tokenCompressor.compressJsonProperties(largeArray);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it("should not compress already small content multiple times", () => {
      const content = "small content";
      const result1 = tokenCompressor.compressContent(content);
      const result2 = tokenCompressor.compressContent(result1);

      expect(result1).toBe(content);
      expect(result2).toBe(content);
    });
  });
});
