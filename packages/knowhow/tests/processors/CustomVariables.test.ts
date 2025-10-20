import { Message } from "../../src/clients/types";
import { CustomVariables } from "../../src/processors/CustomVariables";
import { ToolsService } from "../../src/services";

describe("CustomVariables", () => {
  let customVariables: CustomVariables;
  let mockToolsService: jest.Mocked<ToolsService>;

  beforeEach(() => {
    mockToolsService = {
      addTools: jest.fn(),
      addFunctions: jest.fn(),
      getTool: jest.fn().mockReturnValue(undefined),
      callTool: jest.fn(),
    } as any;

    customVariables = new CustomVariables(mockToolsService);
  });

  afterEach(() => {
    customVariables.clearVariables();
  });

  describe("constructor", () => {
    it("should register all variable tools with ToolsService", () => {
      expect(mockToolsService.addTools).toHaveBeenCalledTimes(1);
      expect(mockToolsService.addFunctions).toHaveBeenCalledTimes(1);

      // Verify all tools are registered
      const addToolCalls = mockToolsService.addTools.mock.calls;
      const toolNames = addToolCalls[0][0].map((args) => args.function.name);

      expect(toolNames).toContain("setVariable");
      expect(toolNames).toContain("getVariable");
      expect(toolNames).toContain("storeToolCallToVariable");
      expect(toolNames).toContain("listVariables");
      expect(toolNames).toContain("deleteVariable");
    });

    it("should overwrite tools if they already exist", () => {
      mockToolsService.getTool.mockReturnValue({
        type: "function",
        function: { name: "setVariable" },
      } as any);
      const newCustomVariables = new CustomVariables(mockToolsService);

      // Should still be called once per instance creation
      expect(mockToolsService.addTools).toHaveBeenCalledTimes(2);
    });
  });

  describe("variable name validation", () => {
    let setVariableFunction: (name: string, contents: any) => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      setVariableFunction = setVariableCall[0].setVariable;
    });

    it("should accept valid variable names", () => {
      const result = setVariableFunction("validName123", "test");
      expect(result).toContain("successfully");
    });

    it("should accept underscores in variable names", () => {
      const result = setVariableFunction("valid_name_123", "test");
      expect(result).toContain("successfully");
    });

    it("should reject variable names with special characters", () => {
      const result = setVariableFunction("invalid-name", "test");
      expect(result).toContain("Error: Invalid variable name");
    });

    it("should reject variable names with spaces", () => {
      const result = setVariableFunction("invalid name", "test");
      expect(result).toContain("Error: Invalid variable name");
    });

    it("should reject empty variable names", () => {
      const result = setVariableFunction("", "test");
      expect(result).toContain("Error: Invalid variable name");
    });
  });

  describe("setVariable functionality", () => {
    let setVariableFunction: (name: string, contents: any) => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      setVariableFunction = setVariableCall[0].setVariable;
    });

    it("should store string variables", () => {
      const result = setVariableFunction("testVar", "test value");
      expect(result).toContain('Variable "testVar" has been set successfully');
      expect(customVariables.getVariableNames()).toContain("testVar");
    });

    it("should store numeric variables", () => {
      const result = setVariableFunction("numVar", 42);
      expect(result).toContain("successfully");
      expect(customVariables.getVariableNames()).toContain("numVar");
    });

    it("should store object variables", () => {
      const testObj = { key: "value", nested: { data: "test" } };
      const result = setVariableFunction("objVar", testObj);
      expect(result).toContain("successfully");
    });

    it("should overwrite existing variables", () => {
      setVariableFunction("testVar", "first value");
      const result = setVariableFunction("testVar", "second value");
      expect(result).toContain("successfully");
      expect(customVariables.getVariableCount()).toBe(1);
    });
  });

  describe("getVariable functionality", () => {
    let setVariableFunction: (name: string, contents: any) => string;
    let getVariableFunction: (varName: string) => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      const getVariableCall = addFunctionsCalls.find(
        (call) => call[0].getVariable
      );
      setVariableFunction = setVariableCall[0].setVariable;
      getVariableFunction = getVariableCall[0].getVariable;
    });

    it("should retrieve string variables", () => {
      setVariableFunction("testVar", "test value");
      const result = getVariableFunction("testVar");
      expect(result).toBe("test value");
    });

    it("should return JSON for object variables", () => {
      const testObj = { key: "value", number: 42 };
      setVariableFunction("objVar", testObj);
      const result = getVariableFunction("objVar");
      expect(result).toContain('"key": "value"');
      expect(result).toContain('"number": 42');
    });

    it("should return error for undefined variables", () => {
      const result = getVariableFunction("undefinedVar");
      expect(result).toContain('Error: Variable "undefinedVar" is not defined');
      expect(result).toContain("Available variables:");
    });

    it("should return error for invalid variable names", () => {
      const result = getVariableFunction("invalid-name");
      expect(result).toContain("Error: Invalid variable name");
    });

    it("should list available variables in error message", () => {
      setVariableFunction("var1", "value1");
      setVariableFunction("var2", "value2");
      const result = getVariableFunction("undefinedVar");
      expect(result).toContain("var1, var2");
    });
  });
  describe("listVariables functionality", () => {
    let setVariableFunction: (name: string, contents: any) => string;
    let listVariablesFunction: () => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      const listVariablesCall = addFunctionsCalls.find(
        (call) => call[0].listVariables
      );
      setVariableFunction = setVariableCall[0].setVariable;
      listVariablesFunction = listVariablesCall[0].listVariables;
    });

    it("should return message when no variables exist", () => {
      const result = listVariablesFunction();
      expect(result).toBe("No variables are currently stored.");
    });

    it("should list all variables with previews", () => {
      setVariableFunction("var1", "short value");
      setVariableFunction("var2", "x".repeat(100)); // Long value
      setVariableFunction("objVar", { key: "value" });

      const result = listVariablesFunction();
      expect(result).toContain("Currently stored variables (3):");
      expect(result).toContain("var1: short value");
      expect(result).toContain("var2: " + "x".repeat(50) + "...");
      expect(result).toContain("objVar:");
    });

    it("should truncate long variable previews", () => {
      const longValue = "x".repeat(100);
      setVariableFunction("longVar", longValue);

      const result = listVariablesFunction();
      expect(result).toContain("longVar: " + "x".repeat(50) + "...");
    });
  });

  describe("deleteVariable functionality", () => {
    let setVariableFunction: (name: string, contents: any) => string;
    let deleteVariableFunction: (varName: string) => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      const deleteVariableCall = addFunctionsCalls.find(
        (call) => call[0].deleteVariable
      );
      setVariableFunction = setVariableCall[0].setVariable;
      deleteVariableFunction = deleteVariableCall[0].deleteVariable;
    });

    it("should delete existing variables", () => {
      setVariableFunction("testVar", "test value");
      const result = deleteVariableFunction("testVar");
      expect(result).toContain(
        'Variable "testVar" has been deleted successfully'
      );
      expect(customVariables.getVariableNames()).not.toContain("testVar");
    });

    it("should return error for non-existent variables", () => {
      const result = deleteVariableFunction("nonExistent");
      expect(result).toContain('Error: Variable "nonExistent" is not defined');
    });

    it("should return error for invalid variable names", () => {
      const result = deleteVariableFunction("invalid-name");
      expect(result).toContain("Error: Invalid variable name");
    });
  });

  describe("storeToolCallToVariable functionality", () => {
    let storeToolCallFunction: (
      varName: string,
      toolName: string,
      toolArgs: string
    ) => Promise<string>;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const storeToolCallCall = addFunctionsCalls.find(
        (call) => call[0].storeToolCallToVariable
      );
      storeToolCallFunction = storeToolCallCall[0].storeToolCallToVariable;
    });

    it("should execute tool call and store result", async () => {
      const mockResult = {
        toolMessages: [],
        toolCallId: "test-call-id",
        functionName: "testTool",
        functionArgs: { param1: "value1" },
        functionResp: { success: true, data: "test data" },
      };
      mockToolsService.callTool.mockResolvedValue(mockResult);

      const result = await storeToolCallFunction(
        "resultVar",
        "testTool",
        '{"param1": "value1"}'
      );

      expect(result).toContain(
        'Tool call result for "testTool" has been stored in variable "resultVar"'
      );
      expect(mockToolsService.callTool).toHaveBeenCalledWith({
        id: expect.any(String),
        type: "function",
        function: {
          name: "testTool",
          arguments: { param1: "value1" },
        },
      });
    });

    it("should return error for invalid JSON arguments", async () => {
      const result = await storeToolCallFunction(
        "resultVar",
        "testTool",
        "invalid json"
      );
      expect(result).toContain("Error: Invalid JSON in toolArgs parameter");
    });

    it("should return error for invalid variable names", async () => {
      const result = await storeToolCallFunction(
        "invalid-name",
        "testTool",
        "{}"
      );
      expect(result).toContain("Error: Invalid variable name");
    });

    it("should handle tool execution errors", async () => {
      mockToolsService.callTool.mockRejectedValue(
        new Error("Tool execution failed")
      );

      const result = await storeToolCallFunction("resultVar", "testTool", "{}");
      expect(result).toContain(
        "Error storing tool call result: Tool execution failed"
      );
    });
  });

  describe("variable substitution in messages", () => {
    let setVariableFunction: (name: string, contents: any) => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      setVariableFunction = setVariableCall[0].setVariable;
    });

    it("should substitute variables in message content", async () => {
      setVariableFunction("userName", "Alice");
      setVariableFunction("greeting", "Hello");

      const messages = [
        {
          role: "user" as const,
          content: "{{greeting}} {{userName}}, how are you today?",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);
      expect(modifiedMessages[0].content).toBe(
        "Hello Alice, how are you today?"
      );
    });

    it("should handle multiple substitutions in single message", async () => {
      setVariableFunction("var1", "first");
      setVariableFunction("var2", "second");
      setVariableFunction("var3", "third");

      const messages = [
        {
          role: "user" as const,
          content: "{{var1}} and {{var2}} and {{var3}}",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);
      expect(modifiedMessages[0].content).toBe("first and second and third");
    });

    it("should handle object variables with JSON serialization", async () => {
      setVariableFunction("config", { api: "v1", timeout: 5000 });

      const messages = [
        {
          role: "user" as const,
          content: "Configuration: {{config}}",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      expect(modifiedMessages[0].content).toBe(
        'Configuration: {"api":"v1","timeout":5000}'
      );
    });

    it("should return error for undefined variables", async () => {
      const messages = [
        {
          role: "user" as const,
          content: "Hello {{undefinedVar}}",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      expect(modifiedMessages[0].content).toBe(
        '{{ERROR: Variable "undefinedVar" is not defined}}'
      );
    });

    it("should handle partial substitutions with mixed defined/undefined vars", async () => {
      setVariableFunction("defined", "value");

      const messages = [
        {
          role: "user" as const,
          content: "{{defined}} and {{undefined}}",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      expect(modifiedMessages[0].content).toBe(
        'value and {{ERROR: Variable "undefined" is not defined}}'
      );
    });

    it("should preserve message structure while substituting content", async () => {
      setVariableFunction("test", "replaced");

      const messages = [
        {
          role: "assistant" as const,
          content: "Original {{test}} content",
          metadata: { id: "test-id" },
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      expect(modifiedMessages[0]).toEqual({
        role: "assistant",
        content: "Original replaced content",
        metadata: { id: "test-id" },
      });
    });

    it("should handle nested variable references", async () => {
      setVariableFunction("innerVar", "inner");
      setVariableFunction("outerVar", "{{innerVar}}");

      const messages = [
        {
          role: "user" as const,
          content: "{{outerVar}} value",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);
      expect(modifiedMessages[0].content).toBe("{{innerVar}} value"); // Only one level of substitution
    });

    it("should handle empty and whitespace variables", async () => {
      setVariableFunction("empty", "");
      setVariableFunction("spaces", "   ");

      const messages = [
        {
          role: "user" as const,
          content: "Empty: '{{empty}}' Spaces: '{{spaces}}'",
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);
      expect(modifiedMessages[0].content).toBe("Empty: '' Spaces: '   '");
    });
  });
});
