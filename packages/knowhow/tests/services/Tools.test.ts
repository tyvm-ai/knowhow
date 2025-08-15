import { ToolsService, ToolContext } from "../../src/services/Tools";
import { Tool, ToolCall } from "../../src/clients/types";
import { createPatternMatcher } from "../../src/services/types";
import { AgentService } from "../../src/services/AgentService";
import { EventService } from "../../src/services/EventService";
import { AIClient } from "../../src/clients";
import { PluginService } from "../../src/plugins/plugins";

describe("ToolsService", () => {
  let toolsService: ToolsService;

  beforeEach(() => {
    toolsService = new ToolsService();
  });

  describe("constructor", () => {
    it("should initialize with empty context when no context is provided", () => {
      const service = new ToolsService();
      const context = service.getContext();

      expect(context).toBeDefined();
      expect(context.Tools).toBe(service);
      expect(context.Agents).toBeUndefined();
      expect(context.Events).toBeUndefined();
      expect(context.Clients).toBeUndefined();
      expect(context.Plugins).toBeUndefined();
    });

    it("should initialize with provided context", () => {
      const mockAgents = {} as AgentService;
      const mockEvents = {} as EventService;
      const initialContext: ToolContext = {
        Agents: mockAgents,
        Events: mockEvents,
      };

      const service = new ToolsService(initialContext);
      const context = service.getContext();

      expect(context.Tools).toBe(service);
      expect(context.Agents).toBe(mockAgents);
      expect(context.Events).toBe(mockEvents);
    });
  });

  describe("context management", () => {
    it("should set and get context", () => {
      const mockContext: ToolContext = {
        Agents: {} as AgentService,
        metadata: { test: "value" },
      };

      toolsService.setContext(mockContext);
      const context = toolsService.getContext();

      expect(context.Tools).toBe(toolsService);
      expect(context.Agents).toBe(mockContext.Agents);
      expect(context.metadata).toEqual({ test: "value" });
    });

    it("should add context properties", () => {
      const mockAgents = {} as AgentService;

      toolsService.addContext("Agents", mockAgents);
      const context = toolsService.getContext();

      expect(context.Agents).toBe(mockAgents);
      expect(context.Tools).toBe(toolsService);
    });
  });

  describe("tool management", () => {
    const mockTool: Tool = {
      type: "function",
      function: {
        name: "testTool",
        description: "A test tool",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "Test input" },
          },
          required: ["input"],
        },
      },
    };

    it("should add a single tool", () => {
      toolsService.addTool(mockTool);

      expect(toolsService.getTools()).toContain(mockTool);
      expect(toolsService.getToolNames()).toContain("testTool");
    });

    it("should add multiple tools", () => {
      const tool2: Tool = {
        type: "function",
        function: {
          name: "testTool2",
          description: "Another test tool",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };

      toolsService.addTools([mockTool, tool2]);

      expect(toolsService.getTools()).toHaveLength(2);
      expect(toolsService.getToolNames()).toEqual(["testTool", "testTool2"]);
    });

    it("should prevent duplicate tool names", () => {
      toolsService.addTool(mockTool);
      toolsService.addTools([mockTool]); // Try to add same tool again

      expect(toolsService.getTools()).toHaveLength(1);
    });

    it("should get tool by name", () => {
      toolsService.addTool(mockTool);

      const retrievedTool = toolsService.getTool("testTool");
      expect(retrievedTool).toBe(mockTool);

      const nonExistentTool = toolsService.getTool("nonExistent");
      expect(nonExistentTool).toBeUndefined();
    });

    it("should get tools by names", () => {
      const tool2: Tool = {
        type: "function",
        function: {
          name: "testTool2",
          description: "Another test tool",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };

      toolsService.addTools([mockTool, tool2]);

      const selectedTools = toolsService.getToolsByNames(["testTool"]);
      expect(selectedTools).toHaveLength(1);
      expect(selectedTools[0]).toBe(mockTool);
    });
  });

  describe("function management", () => {
    it("should set and get functions", () => {
      const testFunction = jest.fn().mockReturnValue("test result");

      toolsService.setFunction("testFunc", testFunction);
      const retrievedFunction = toolsService.getFunction("testFunc");

      expect(retrievedFunction).toBeDefined();
      expect(typeof retrievedFunction).toBe("function");
    });

    it("should add multiple functions", () => {
      const functions = {
        func1: jest.fn(),
        func2: jest.fn()
      };

      toolsService.addFunctions(functions);

      expect(toolsService.getFunction("func1")).toBeDefined();
      expect(toolsService.getFunction("func2")).toBeDefined();
    });

    it("should set multiple functions by names and functions arrays", () => {
      const func1 = jest.fn();
      const func2 = jest.fn();

      toolsService.setFunctions(["test1", "test2"], [func1, func2]);

      expect(toolsService.getFunction("test1")).toBeDefined();
      expect(toolsService.getFunction("test2")).toBeDefined();
    });

    it("should define tools and functions together", () => {
      const mockTool: Tool = {
        type: "function",
        function: {
          name: "combinedTool",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };

      const mockFunction = jest.fn();

      toolsService.defineTools([mockTool], { combinedTool: mockFunction });

      expect(toolsService.getTool("combinedTool")).toBe(mockTool);
      expect(toolsService.getFunction("combinedTool")).toBeDefined();
    });
  });

  describe("copyToolsFrom", () => {
    it("should copy tools and functions from another ToolsService", () => {
      const sourceService = new ToolsService();
      const mockTool: Tool = {
        type: "function",
        function: {
          name: "sourceTool",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };
      const mockFunction = jest.fn();

      sourceService.addTool(mockTool);
      sourceService.setFunction("sourceTool", mockFunction);

      toolsService.copyToolsFrom(["sourceTool"], sourceService);

      expect(toolsService.getTool("sourceTool")).toEqual(mockTool);
      expect(toolsService.getFunction("sourceTool")).toBeDefined();
    });
  });
  describe("callTool", () => {
    const mockTool: Tool = {
      type: "function",
      function: {
        name: "testTool",
        description: "A test tool",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "Test input" },
            optional: { type: "string", description: "Optional input" },
          },
          required: ["input"],
        },
      },
    };

    const mockToolCall: ToolCall = {
      id: "call_123",
      type: "function",
      function: {
        name: "testTool",
        arguments: JSON.stringify({ input: "test value" }),
      },
    };

    beforeEach(() => {
      toolsService.addTool(mockTool);
      jest.clearAllMocks();
    });

    it("should successfully call a tool with correct arguments", async () => {
      const mockFunction = jest.fn().mockResolvedValue("success result");
      toolsService.setFunction("testTool", mockFunction);

      const result = await toolsService.callTool(mockToolCall);

      expect(mockFunction).toHaveBeenCalledWith({ input: "test value" });
      expect(result.toolMessages).toHaveLength(1);
      expect(result.toolMessages[0]).toEqual({
        tool_call_id: "call_123",
        role: "tool",
        name: "testTool",
        content: "success result",
      });
      expect(result.functionResp).toBe("success result");
    });

    it("should handle positional arguments", async () => {
      const positionalTool: Tool = {
        type: "function",
        function: {
          name: "positionalTool",
          parameters: {
            type: "object",
            positional: true,
            properties: {
              arg1: { type: "string" },
              arg2: { type: "number" },
            },
            required: ["arg1", "arg2"],
          },
        },
      };

      const positionalCall: ToolCall = {
        id: "call_456",
        type: "function",
        function: {
          name: "positionalTool",
          arguments: JSON.stringify({ arg1: "hello", arg2: 42 }),
        },
      };

      const mockFunction = jest.fn().mockResolvedValue("positional result");

      toolsService.addTool(positionalTool);
      toolsService.setFunction("positionalTool", mockFunction);

      await toolsService.callTool(positionalCall);

      expect(mockFunction).toHaveBeenCalledWith("hello", 42);
    });

    it("should handle tool not enabled error", async () => {
      const mockFunction = jest.fn();
      toolsService.setFunction("testTool", mockFunction);

      const result = await toolsService.callTool(mockToolCall, ["otherTool"]);

      expect(mockFunction).not.toHaveBeenCalled();
      expect(result.toolMessages[0].name).toBe("error");
      expect(result.toolMessages[0].content).toContain("not enabled");
      expect(result.functionResp).toBeUndefined();
    });

    it("should handle tool definition not found", async () => {
      const unknownToolCall: ToolCall = {
        id: "call_unknown",
        type: "function",
        function: {
          name: "unknownTool",
          arguments: "{}",
        },
      };

      const result = await toolsService.callTool(unknownToolCall);

      expect(result.toolMessages[0].name).toBe("error");
      expect(result.toolMessages[0].content).toContain("not enabled");
    });

    it("should handle function implementation not found", async () => {
      // Tool is defined but no function implementation
      const result = await toolsService.callTool(mockToolCall);

      expect(result.toolMessages[0].name).toBe("error");
      expect(result.toolMessages[0].content).toContain("not found");
    });

    it("should handle function execution errors", async () => {
      const mockFunction = jest
        .fn()
        .mockRejectedValue(new Error("Function failed"));
      toolsService.setFunction("testTool", mockFunction);

      const result = await toolsService.callTool(mockToolCall);

      expect(result.toolMessages[0].name).toBe("error");
      expect(result.toolMessages[0].content).toContain(
        "ERROR: Function failed"
      );
      expect(result.functionResp).toBeUndefined();
    });

    it("should handle object responses by converting to JSON", async () => {
      const mockFunction = jest
        .fn()
        .mockResolvedValue({ key: "value", nested: { data: 123 } });
      toolsService.setFunction("testTool", mockFunction);

      const result = await toolsService.callTool(mockToolCall);

      expect(result.toolMessages[0].content).toBe(
        JSON.stringify({ key: "value", nested: { data: 123 } }, null, 2)
      );
    });

    it("should handle multi_tool_use.parallel special case", async () => {
      const parallelTool: Tool = {
        type: "function",
        function: {
          name: "multi_tool_use.parallel",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };

      const parallelCall: ToolCall = {
        id: "call_parallel",
        type: "function",
        function: {
          name: "multi_tool_use.parallel",
          arguments: JSON.stringify([
            { recipient_name: "tool1.action", parameters: {} },
            { recipient_name: "tool2.action", parameters: {} },
          ]),
        },
      };

      const mockFunction = jest.fn().mockResolvedValue(["result1", "result2"]);

      toolsService.addTool(parallelTool);
      toolsService.setFunction("multi_tool_use.parallel", mockFunction);

      const result = await toolsService.callTool(parallelCall);

      expect(result.toolMessages).toHaveLength(2);
      expect(result.toolMessages[0].tool_call_id).toBe("call_parallel_0");
      expect(result.toolMessages[1].tool_call_id).toBe("call_parallel_1");
      expect(result.toolMessages[0].name).toBe("action");
      expect(result.toolMessages[1].name).toBe("action");
    });

    it("should handle string arguments that need parsing", async () => {
      const toolCallWithStringArgs: ToolCall = {
        id: "call_string",
        type: "function",
        function: {
          name: "testTool",
          arguments: '{"input": "escaped\\nstring"}',
        },
      };

      const mockFunction = jest.fn().mockResolvedValue("success");
      toolsService.setFunction("testTool", mockFunction);

      await toolsService.callTool(toolCallWithStringArgs);

      expect(mockFunction).toHaveBeenCalledWith({ input: "escaped\nstring" });
    });
  });
  describe("Tool Override System", () => {
    const mockTool: Tool = {
      type: "function",
      function: {
        name: "overridableTool",
        description: "A tool that can be overridden",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
      },
    };

    beforeEach(() => {
      toolsService.addTool(mockTool);
      jest.clearAllMocks();
    });

    it("should register override with string pattern", () => {
      const overrideFunction = jest.fn().mockResolvedValue("override result");

      toolsService.registerOverride("overridableTool", overrideFunction);

      expect(() => toolsService.getFunction("overridableTool")).not.toThrow();
    });

    it("should register override with regex pattern", () => {
      const overrideFunction = jest.fn().mockResolvedValue("regex override");
      const pattern = /^overridable/;

      toolsService.registerOverride(pattern, overrideFunction);

      expect(() => toolsService.getFunction("overridableTool")).not.toThrow();
    });

    it("should execute override function instead of original", async () => {
      const originalFunction = jest.fn().mockResolvedValue("original result");
      const overrideFunction = jest.fn().mockResolvedValue("override result");

      toolsService.setFunction("overridableTool", originalFunction);
      toolsService.registerOverride("overridableTool", overrideFunction);

      const toolCall: ToolCall = {
        id: "call_override",
        type: "function",
        function: {
          name: "overridableTool",
          arguments: JSON.stringify({ input: "test" }),
        },
      };

      const result = await toolsService.callTool(toolCall);

      expect(overrideFunction).toHaveBeenCalledWith({ input: "test" });
      expect(originalFunction).not.toHaveBeenCalled();
      expect(result.functionResp).toBe("override result");
    });

    it("should handle override priority ordering", () => {
      const override1 = jest.fn().mockResolvedValue("override1");
      const override2 = jest.fn().mockResolvedValue("override2");

      // Register with different priorities
      toolsService.registerOverride("overridableTool", override1, 1);
      toolsService.registerOverride("overridableTool", override2, 2);

      // Higher priority should be used
      const func = toolsService.getFunction("overridableTool");
      expect(func).toBe(override2);
    });

    it("should handle pattern matching with wildcards", () => {
      const overrideFunction = jest.fn().mockResolvedValue("wildcard override");

      toolsService.registerOverride("override*Tool", overrideFunction);

      const func = toolsService.getFunction("overridableTool");
      expect(func).toBe(overrideFunction);
    });

    it("should remove overrides", () => {
      const originalFunction = jest.fn().mockResolvedValue("original");
      const overrideFunction = jest.fn().mockResolvedValue("override");

      toolsService.setFunction("overridableTool", originalFunction);
      toolsService.registerOverride("overridableTool", overrideFunction);

      // Override should be active
      expect(toolsService.getFunction("overridableTool")).toBe(
        overrideFunction
      );

      toolsService.removeOverride("overridableTool");

      // Should return to original
      expect(toolsService.getFunction("overridableTool")).toBe(
        originalFunction
      );
    });

    it("should preserve original functions when override is registered", () => {
      const originalFunction = jest.fn().mockResolvedValue("original");
      const overrideFunction = jest.fn().mockResolvedValue("override");

      toolsService.setFunction("overridableTool", originalFunction);
      toolsService.registerOverride("overridableTool", overrideFunction);

      const originalStored =
        toolsService.getOriginalFunction("overridableTool");
      expect(originalStored).toBe(originalFunction);
    });
  });

  describe("Tool Wrapper System", () => {
    const mockTool: Tool = {
      type: "function",
      function: {
        name: "wrappableTool",
        description: "A tool that can be wrapped",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
      },
    };

    beforeEach(() => {
      toolsService.addTool(mockTool);
      jest.clearAllMocks();
    });

    it("should register wrapper with string pattern", () => {
      const wrapperFunction = jest
        .fn()
        .mockImplementation((originalFn, args) => {
          return originalFn(args);
        });

      toolsService.registerWrapper("wrappableTool", wrapperFunction);

      expect(() => toolsService.getFunction("wrappableTool")).not.toThrow();
    });

    it("should register wrapper with regex pattern", () => {
      const wrapperFunction = jest
        .fn()
        .mockImplementation((originalFn, args) => {
          return originalFn(args);
        });
      const pattern = /^wrappable/;

      toolsService.registerWrapper(pattern, wrapperFunction);

      expect(() => toolsService.getFunction("wrappableTool")).not.toThrow();
    });

    it("should execute wrapper function with original function", async () => {
      const originalFunction = jest.fn().mockResolvedValue("original result");
      const wrapperFunction = jest
        .fn()
        .mockImplementation(async (originalFn, args) => {
          const result = await originalFn(args);
          return `wrapped: ${result}`;
        });

      toolsService.setFunction("wrappableTool", originalFunction);
      toolsService.registerWrapper("wrappableTool", wrapperFunction);

      const toolCall: ToolCall = {
        id: "call_wrapper",
        type: "function",
        function: {
          name: "wrappableTool",
          arguments: JSON.stringify({ input: "test" }),
        },
      };

      const result = await toolsService.callTool(toolCall);

      expect(wrapperFunction).toHaveBeenCalled();
      expect(originalFunction).toHaveBeenCalledWith({ input: "test" });
      expect(result.functionResp).toBe("wrapped: original result");
    });

    it("should handle wrapper priority ordering", () => {
      const originalFunction = jest.fn().mockResolvedValue("original");
      const wrapper1 = jest.fn().mockImplementation((fn, args) => fn(args));
      const wrapper2 = jest.fn().mockImplementation((fn, args) => fn(args));

      toolsService.setFunction("wrappableTool", originalFunction);
      toolsService.registerWrapper("wrappableTool", wrapper1, 1);
      toolsService.registerWrapper("wrappableTool", wrapper2, 2);

      // Should use higher priority wrapper
      const func = toolsService.getFunction("wrappableTool");
      expect(func).not.toBe(originalFunction);
      expect(func).not.toBe(wrapper1);
    });

    it("should support multiple wrapper chaining", async () => {
      const originalFunction = jest.fn().mockResolvedValue("original");

      const wrapper1 = jest
        .fn()
        .mockImplementation(async (originalFn, args) => {
          const result = await originalFn(args);
          return `wrapper1(${result})`;
        });

      const wrapper2 = jest
        .fn()
        .mockImplementation(async (originalFn, args) => {
          const result = await originalFn(args);
          return `wrapper2(${result})`;
        });

      toolsService.setFunction("wrappableTool", originalFunction);
      toolsService.registerWrapper("wrappableTool", wrapper1, 1);
      toolsService.registerWrapper("wrappableTool", wrapper2, 2);

      const toolCall: ToolCall = {
        id: "call_chained",
        type: "function",
        function: {
          name: "wrappableTool",
          arguments: JSON.stringify({ input: "test" }),
        },
      };

      const result = await toolsService.callTool(toolCall);

      expect(result.functionResp).toContain("wrapper");
      expect(originalFunction).toHaveBeenCalled();
    });

    it("should remove wrappers", () => {
      const originalFunction = jest.fn().mockResolvedValue("original");
      const wrapperFunction = jest
        .fn()
        .mockImplementation((fn, args) => fn(args));

      toolsService.setFunction("wrappableTool", originalFunction);
      toolsService.registerWrapper("wrappableTool", wrapperFunction);

      // Wrapper should be active
      expect(toolsService.getFunction("wrappableTool")).not.toBe(
        originalFunction
      );

      toolsService.removeWrapper("wrappableTool");

      // Should return to original
      expect(toolsService.getFunction("wrappableTool")).toBe(originalFunction);
    });
  });
  describe("Pattern Matching", () => {
    it("should match glob patterns with wildcards", () => {
      const originalFunction = jest.fn();
      const overrideFunction = jest.fn();

      toolsService.setFunction("testTool", originalFunction);
      toolsService.setFunction("testHelper", originalFunction);
      toolsService.setFunction("otherTool", originalFunction);

      // Register override with glob pattern
      toolsService.registerOverride("test*", overrideFunction);

      // Should match tools starting with "test"
      expect(toolsService.getFunction("testTool")).toBe(overrideFunction);
      expect(toolsService.getFunction("testHelper")).toBe(overrideFunction);
      expect(toolsService.getFunction("otherTool")).toBe(originalFunction);
    });

    it("should match regex patterns", () => {
      const originalFunction = jest.fn();
      const overrideFunction = jest.fn();

      toolsService.setFunction("tool123", originalFunction);
      toolsService.setFunction("tool456", originalFunction);
      toolsService.setFunction("toolABC", originalFunction);

      // Register override with regex pattern for tools ending with numbers
      toolsService.registerOverride(/tool\d+$/, overrideFunction);

      expect(toolsService.getFunction("tool123")).toBe(overrideFunction);
      expect(toolsService.getFunction("tool456")).toBe(overrideFunction);
      expect(toolsService.getFunction("toolABC")).toBe(originalFunction);
    });

    it("should handle complex glob patterns", () => {
      const originalFunction = jest.fn();
      const overrideFunction = jest.fn();

      toolsService.setFunction("api_get_user", originalFunction);
      toolsService.setFunction("api_post_user", originalFunction);
      toolsService.setFunction("api_delete_user", originalFunction);
      toolsService.setFunction("util_format", originalFunction);

      // Match API tools with user operations
      toolsService.registerOverride("api_*_user", overrideFunction);

      expect(toolsService.getFunction("api_get_user")).toBe(overrideFunction);
      expect(toolsService.getFunction("api_post_user")).toBe(overrideFunction);
      expect(toolsService.getFunction("api_delete_user")).toBe(
        overrideFunction
      );
      expect(toolsService.getFunction("util_format")).toBe(originalFunction);
    });

    it("should test pattern matcher factory function directly", () => {
      // Test string pattern matcher
      const stringMatcher = createPatternMatcher("test*");
      expect(stringMatcher.matches("testTool")).toBe(true);
      expect(stringMatcher.matches("otherTool")).toBe(false);

      // Test regex pattern matcher
      const regexMatcher = createPatternMatcher(/^api_/);
      expect(regexMatcher.matches("api_call")).toBe(true);
      expect(regexMatcher.matches("util_call")).toBe(false);
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should handle malformed tool call arguments", async () => {
      const mockTool: Tool = {
        type: "function",
        function: {
          name: "testTool",
          parameters: { type: "object", properties: {}, required: [] },
        },
      };

      const malformedCall: ToolCall = {
        id: "call_malformed",
        type: "function",
        function: {
          name: "testTool",
          arguments: "invalid json {",
        },
      };

      toolsService.addTool(mockTool);
      toolsService.setFunction(
        "testTool",
        jest.fn().mockResolvedValue("result")
      );

      const result = await toolsService.callTool(malformedCall);

      expect(result.toolMessages[0].name).toBe("error");
      expect(result.toolMessages[0].content).toContain("JSON");
    });

    it("should handle tools with no parameters", async () => {
      const noParamTool: Tool = {
        type: "function",
        function: {
          name: "noParamTool",
          description: "Tool with no parameters",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };

      const noParamCall: ToolCall = {
        id: "call_no_param",
        type: "function",
        function: {
          name: "noParamTool",
          arguments: "{}",
        },
      };

      const mockFunction = jest.fn().mockResolvedValue("no param result");

      toolsService.addTool(noParamTool);
      toolsService.setFunction("noParamTool", mockFunction);

      const result = await toolsService.callTool(noParamCall);

      expect(mockFunction).toHaveBeenCalledWith({});
      expect(result.functionResp).toBe("no param result");
    });

    it("should handle tools with complex nested parameter structures", async () => {
      const complexTool: Tool = {
        type: "function",
        function: {
          name: "complexTool",
          parameters: {
            type: "object",
            properties: {
              config: {
                type: "object",
                properties: {
                  settings: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        key: { type: "string" },
                        value: { type: "number" },
                      },
                    },
                  },
                },
              },
            },
            required: ["config"],
          },
        },
      };

      const complexCall: ToolCall = {
        id: "call_complex",
        type: "function",
        function: {
          name: "complexTool",
          arguments: JSON.stringify({
            config: {
              settings: [
                { key: "timeout", value: 5000 },
                { key: "retries", value: 3 },
              ],
            },
          }),
        },
      };

      const mockFunction = jest.fn().mockResolvedValue("complex result");

      toolsService.addTool(complexTool);
      toolsService.setFunction("complexTool", mockFunction);

      const result = await toolsService.callTool(complexCall);

      expect(mockFunction).toHaveBeenCalledWith({
        config: {
          settings: [
            { key: "timeout", value: 5000 },
            { key: "retries", value: 3 },
          ],
        },
      });
      expect(result.functionResp).toBe("complex result");
    });

    it("should handle concurrent tool calls", async () => {
      const concurrentTool: Tool = {
        type: "function",
        function: {
          name: "concurrentTool",
          parameters: {
            type: "object",
            properties: {
              delay: { type: "number" },
            },
            required: ["delay"],
          },
        },
      };

      const mockFunction = jest.fn().mockImplementation(async ({ delay }) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return `completed after ${delay}ms`;
      });

      toolsService.addTool(concurrentTool);
      toolsService.setFunction("concurrentTool", mockFunction);

      const call1: ToolCall = {
        id: "call_1",
        type: "function",
        function: {
          name: "concurrentTool",
          arguments: JSON.stringify({ delay: 100 }),
        },
      };

      const call2: ToolCall = {
        id: "call_2",
        type: "function",
        function: {
          name: "concurrentTool",
          arguments: JSON.stringify({ delay: 50 }),
        },
      };

      const [result1, result2] = await Promise.all([
        toolsService.callTool(call1),
        toolsService.callTool(call2),
      ]);

      expect(result1.functionResp).toBe("completed after 100ms");
      expect(result2.functionResp).toBe("completed after 50ms");
      expect(mockFunction).toHaveBeenCalledTimes(2);
    });

    it("should handle undefined and null function responses", async () => {
      const mockTool: Tool = {
        type: "function",
        function: {
          name: "undefinedTool",
          parameters: { type: "object", properties: {}, required: [] },
        },
      };

      const toolCall: ToolCall = {
        id: "call_undefined",
        type: "function",
        function: {
          name: "undefinedTool",
          arguments: "{}",
        },
      };

      toolsService.addTool(mockTool);

      // Test undefined response
      toolsService.setFunction(
        "undefinedTool",
        jest.fn().mockResolvedValue(undefined)
      );
      let result = await toolsService.callTool(toolCall);
      expect(result.toolMessages[0].content).toBe("undefined");

      // Test null response
      toolsService.setFunction(
        "undefinedTool",
        jest.fn().mockResolvedValue(null)
      );
      result = await toolsService.callTool(toolCall);
      expect(result.toolMessages[0].content).toBe("null");
    });
  });

  describe("Integration Tests", () => {
    it("should handle complete workflow with override and wrapper", async () => {
      const baseTool: Tool = {
        type: "function",
        function: {
          name: "workflowTool",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
            required: ["input"],
          },
        },
      };

      const originalFunction = jest.fn().mockResolvedValue("original");
      const wrapperFunction = jest
        .fn()
        .mockImplementation(async (originalFn, args) => {
          const result = await originalFn(args);
          return `wrapped: ${result}`;
        });
      const overrideFunction = jest.fn().mockResolvedValue("override");

      toolsService.addTool(baseTool);
      toolsService.setFunction("workflowTool", originalFunction);
      toolsService.registerWrapper("workflowTool", wrapperFunction);
      toolsService.registerOverride("workflowTool", overrideFunction);

      const toolCall: ToolCall = {
        id: "call_workflow",
        type: "function",
        function: {
          name: "workflowTool",
          arguments: JSON.stringify({ input: "test" }),
        },
      };

      const result = await toolsService.callTool(toolCall);

      // Override should take precedence over wrapper
      expect(overrideFunction).toHaveBeenCalled();
      expect(wrapperFunction).not.toHaveBeenCalled();
      expect(originalFunction).not.toHaveBeenCalled();
      expect(result.functionResp).toBe("override");
    });

    it("should maintain tool state across multiple operations", () => {
      const tools: Tool[] = [
        {
          type: "function",
          function: {
            name: "tool1",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
        {
          type: "function",
          function: {
            name: "tool2",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ];

      toolsService.addTools(tools);
      expect(toolsService.getToolsByNames(["tool1", "tool2"])).toHaveLength(2);

      toolsService.setFunction("tool1", jest.fn());
      toolsService.setFunction("tool2", jest.fn());

      expect(toolsService.getFunction("tool1")).toBeDefined();
      expect(toolsService.getFunction("tool2")).toBeDefined();

      // Copy to new service
      const newService = new ToolsService();
      newService.copyToolsFrom(["tool1", "tool2"], toolsService);

      expect(newService.getToolsByNames(["tool1", "tool2"])).toHaveLength(2);
    });
  });
});
