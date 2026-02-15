import { describe, it, expect, beforeEach } from "@jest/globals";
import { ToolResponseCache } from "../../src/processors/ToolResponseCache";
import { ToolsService } from "../../src/services";
import * as fs from "fs";
import * as path from "path";

describe("ToolResponseCache - MCP Format Support", () => {
  let cache: ToolResponseCache;
  let toolsService: ToolsService;
  let githubJsonContent: string;

  beforeEach(() => {
    toolsService = new ToolsService();
    cache = new ToolResponseCache(toolsService);
    
    // Load the githubjson.txt test data
    const githubJsonPath = path.join(__dirname, "githubjson.txt");
    githubJsonContent = fs.readFileSync(githubJsonPath, "utf-8");
  });

  describe("MCP Format Detection and Storage", () => {
    it("should detect and parse MCP format responses", () => {
      // Store the MCP format response
      cache.storeToolResponse(githubJsonContent, "test-mcp-1");

      // Verify it was stored
      const stored = cache.retrieveRawResponse("test-mcp-1");
      expect(stored).toBeDefined();
      expect(stored).not.toBeNull();

      // Verify the stored data is normalized JSON
      const parsed = JSON.parse(stored!);
      expect(parsed._mcp_format).toBe(true);
      expect(parsed._data).toBeDefined();
      expect(Array.isArray(parsed._data)).toBe(true);
    });

    it("should preserve the data array in normalized structure", () => {
      cache.storeToolResponse(githubJsonContent, "test-mcp-2");
      const stored = cache.retrieveRawResponse("test-mcp-2");
      const parsed = JSON.parse(stored!);

      // Verify the data array is present and has the expected structure
      expect(parsed._data).toBeDefined();
      expect(Array.isArray(parsed._data)).toBe(true);
      expect(parsed._data.length).toBeGreaterThan(0);
      
      // Verify first item has expected GitHub repo structure
      const firstRepo = parsed._data[0];
      expect(firstRepo).toHaveProperty("id");
      expect(firstRepo).toHaveProperty("name");
      expect(firstRepo).toHaveProperty("full_name");
      expect(firstRepo).toHaveProperty("owner");
    });

    it("should store _mcp_format flag and _raw_structure metadata", () => {
      cache.storeToolResponse(githubJsonContent, "test-mcp-3");
      const stored = cache.retrieveRawResponse("test-mcp-3");
      const parsed = JSON.parse(stored!);

      expect(parsed._mcp_format).toBe(true);
      expect(parsed._raw_structure).toBeDefined();
      expect(parsed._raw_structure).toHaveProperty("content");
      expect(Array.isArray(parsed._raw_structure.content)).toBe(true);
    });
  });

  describe("JQ Queries Against MCP Data", () => {
    beforeEach(() => {
      cache.storeToolResponse(githubJsonContent, "github-repos");
    });

    it("should query the data array length with ._data | length", async () => {
      const result = await cache.queryToolResponse("github-repos", "._data | length");
      
      // Parse the result to verify it's a number
      const length = JSON.parse(result);
      expect(typeof length).toBe("number");
      expect(length).toBeGreaterThan(0);
    });

    it("should query first item in data array with ._data[0]", async () => {
      const result = await cache.queryToolResponse("github-repos", "._data[0]");
      
      // Parse and verify it's an object with GitHub repo structure
      const firstItem = JSON.parse(result);
      expect(firstItem).toHaveProperty("id");
      expect(firstItem).toHaveProperty("name");
      expect(firstItem).toHaveProperty("full_name");
    });

    it("should query specific field in first item with ._data[0].name", async () => {
      const result = await cache.queryToolResponse("github-repos", "._data[0].name");
      
      // Parse and verify it's a string (repo name)
      const name = JSON.parse(result);
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    });

    it("should map over data array with ._data | map(.name)", async () => {
      const result = await cache.queryToolResponse("github-repos", "._data | map(.name)");
      
      // Parse and verify it's an array of strings
      const names = JSON.parse(result);
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
      expect(typeof names[0]).toBe("string");
    });

    it("should filter data array with ._data | map(select(.private == true))", async () => {
      const result = await cache.queryToolResponse(
        "github-repos",
        "._data | map(select(.private == true))"
      );
      
      // Parse and verify filtering worked
      const privateRepos = JSON.parse(result);
      expect(Array.isArray(privateRepos)).toBe(true);
      
      // Verify all results have private = true
      privateRepos.forEach((repo: any) => {
        expect(repo.private).toBe(true);
      });
    });

    it("should access nested properties with ._data[0].owner.login", async () => {
      const result = await cache.queryToolResponse("github-repos", "._data[0].owner.login");
      
      // Parse and verify it's a string (owner login)
      const login = JSON.parse(result);
      expect(typeof login).toBe("string");
      expect(login.length).toBeGreaterThan(0);
    });
  });

  describe("Non-MCP Format Compatibility", () => {
    it("should handle plain JSON arrays without MCP wrapper", () => {
      const plainArray = JSON.stringify([
        { id: 1, name: "test1" },
        { id: 2, name: "test2" },
      ]);

      cache.storeToolResponse(plainArray, "plain-json");
      const stored = cache.retrieveRawResponse("plain-json");
      
      expect(stored).toBe(plainArray);
      
      // Should not have MCP format markers
      const parsed = JSON.parse(stored!);
      expect(parsed._mcp_format).toBeUndefined();
      expect(Array.isArray(parsed)).toBe(true);
    });

    it("should handle plain JSON objects without MCP wrapper", () => {
      const plainObject = JSON.stringify({ status: "success", data: { value: 42 } });

      cache.storeToolResponse(plainObject, "plain-object");
      const stored = cache.retrieveRawResponse("plain-object");
      
      expect(stored).toBe(plainObject);
      
      // Should not have MCP format markers (note: plain objects may have a "data" field which is fine)
      const parsed = JSON.parse(stored!);
      expect(parsed._mcp_format).toBeUndefined();
      expect(parsed.status).toBe("success");
    });

    it("should handle plain text without JSON parsing", () => {
      const plainText = "This is just plain text, not JSON";

      cache.storeToolResponse(plainText, "plain-text");
      const stored = cache.retrieveRawResponse("plain-text");
      
      expect(stored).toBe(plainText);
    });

    it("should query plain JSON arrays with direct JQ queries", async () => {
      const plainArray = JSON.stringify([
        { id: 1, name: "test1" },
        { id: 2, name: "test2" },
      ]);

      cache.storeToolResponse(plainArray, "plain-array");
      
      // Query without .data prefix since there's no MCP wrapper
      const result = await cache.queryToolResponse("plain-array", ".[0].name");
      const name = JSON.parse(result);
      
      expect(name).toBe("test1");
    });
  });

  describe("Edge Cases and Double-Encoded JSON", () => {
    it("should handle double-encoded JSON strings", () => {
      const data = { test: "value" };
      const doubleEncoded = JSON.stringify(JSON.stringify(data));

      cache.storeToolResponse(doubleEncoded, "double-encoded");
      const stored = cache.retrieveRawResponse("double-encoded");
      
      // Should be parsed to single encoding
      const parsed = JSON.parse(stored!);
      expect(parsed.test).toBe("value");
    });

    it("should handle MCP format with double-encoded text field", () => {
      const innerData = [{ id: 1, value: "test" }];
      const doubleEncodedText = JSON.stringify(JSON.stringify(innerData));
      const mcpWrapper = JSON.stringify({
        content: [{ type: "text", text: doubleEncodedText }],
      });

      cache.storeToolResponse(mcpWrapper, "mcp-double-encoded");
      const stored = cache.retrieveRawResponse("mcp-double-encoded");
      const parsed = JSON.parse(stored!);

      expect(parsed._mcp_format).toBe(true);
      expect(parsed._data).toBeDefined();
      expect(Array.isArray(parsed._data)).toBe(true);
      expect(parsed._data[0].value).toBe("test");
    });

    it("should handle empty MCP content array", () => {
      const emptyMcp = JSON.stringify({
        content: [],
      });

      cache.storeToolResponse(emptyMcp, "empty-mcp");
      const stored = cache.retrieveRawResponse("empty-mcp");
      const parsed = JSON.parse(stored!);

      // Should not be treated as MCP format since content is empty
      expect(parsed._mcp_format).toBeUndefined();
      expect(parsed.content).toBeDefined();
      expect(Array.isArray(parsed.content)).toBe(true);
      expect(parsed.content.length).toBe(0);
    });

    it("should handle MCP format with non-JSON text", () => {
      const mcpWithText = JSON.stringify({
        content: [{ type: "text", text: "This is plain text, not JSON" }],
      });

      cache.storeToolResponse(mcpWithText, "mcp-plain-text");
      const stored = cache.retrieveRawResponse("mcp-plain-text");
      const parsed = JSON.parse(stored!);

      // Should not be treated as MCP format since text is not JSON
      expect(parsed._mcp_format).toBeUndefined();
      expect(parsed.content[0].text).toBe("This is plain text, not JSON");
    });

    it("should not overwrite stored responses on subsequent stores", () => {
      const originalData = JSON.stringify({ original: true });
      const newData = JSON.stringify({ original: false });

      cache.storeToolResponse(originalData, "no-overwrite");
      cache.storeToolResponse(newData, "no-overwrite");

      const stored = cache.retrieveRawResponse("no-overwrite");
      const parsed = JSON.parse(stored!);

      // Should still have the original data
      expect(parsed.original).toBe(true);
    });
  });

  describe("Metadata and Storage Management", () => {
    it("should track metadata for MCP format responses", () => {
      cache.storeToolResponse(githubJsonContent, "meta-test", "github_list_repos");

      const keys = cache.getStorageKeys();
      expect(keys).toContain("meta-test");
      
      const size = cache.getStorageSize();
      expect(size).toBeGreaterThanOrEqual(1);
    });

    it("should list stored tool responses including MCP format", async () => {
      cache.storeToolResponse(githubJsonContent, "repo-list", "github_repos");
      cache.storeToolResponse(JSON.stringify({ test: "data" }), "test-data", "test_tool");

      const list = await cache.listStoredToolResponses();
      
      expect(list).toContain("repo-list");
      expect(list).toContain("test-data");
    });

    it("should clear all stored responses", () => {
      cache.storeToolResponse(githubJsonContent, "clear-test-1");
      cache.storeToolResponse(JSON.stringify({ test: "data" }), "clear-test-2");

      expect(cache.getStorageSize()).toBe(2);

      cache.clearStorage();

      expect(cache.getStorageSize()).toBe(0);
      expect(cache.retrieveRawResponse("clear-test-1")).toBeNull();
      expect(cache.retrieveRawResponse("clear-test-2")).toBeNull();
    });
  });
});
