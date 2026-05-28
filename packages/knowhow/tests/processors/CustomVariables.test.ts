import { Message } from "../../src/clients/types"; 
import { CustomVariables } from "../../src/processors/CustomVariables";
import { ToolsService } from "../../src/services";
import * as fs from "fs";

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

    it("should leave undefined variables unchanged", async () => {
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
        "Hello {{undefinedVar}}"
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
        "value and {{undefined}}"
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

    it("should substitute variables in tool call arguments", async () => {
      setVariableFunction("username", "john_doe");
      setVariableFunction("limit", "10");

      const messages = [
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: {
                name: "searchUsers",
                arguments: JSON.stringify({
                  username: "{{username}}",
                  limit: "{{limit}}",
                }),
              },
            },
          ],
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      expect(modifiedMessages[0].tool_calls?.[0].function.arguments).toBe(
        JSON.stringify({
          username: "john_doe",
          limit: "10",
        })
      );
    });

    it("should leave undefined variables unchanged in tool call arguments", async () => {
      setVariableFunction("defined", "value");

      const messages = [
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "call_456",
              type: "function" as const,
              function: {
                name: "exampleTool",
                arguments: JSON.stringify({
                  param1: "{{defined}}",
                  param2: "{{undefined}}",
                }),
              },
            },
          ],
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      expect(modifiedMessages[0].tool_calls?.[0].function.arguments).toBe(
        JSON.stringify({
          param1: "value",
          param2: "{{undefined}}",
        })
      );
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

  describe("JWT token use case", () => {
    let setVariableFunction: (name: string, contents: any) => string;

    const LONG_JWT =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjE3MTYyMzkwMjIsInJvbGVzIjpbImFkbWluIiwidXNlciJdLCJvcmciOiJhY21lLWNvcnAiLCJlbWFpbCI6ImpvaG5AYWNtZS5jb20ifQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      const setVariableCall = addFunctionsCalls.find(
        (call) => call[0].setVariable
      );
      setVariableFunction = setVariableCall[0].setVariable;
    });

    it("should store a long JWT and substitute it in a tool call argument", async () => {
      // LLM stores the JWT once
      setVariableFunction("jwt_token", LONG_JWT);

      // LLM uses {{jwt_token}} in a tool call instead of repeating the full JWT
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "execCommand",
                arguments: JSON.stringify({
                  command: 'curl -H "Authorization: Bearer {{jwt_token}}" https://api.example.com/data',
                }),
              },
            },
          ],
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      // The tool call argument should have the full JWT substituted in
      const args = JSON.parse(modifiedMessages[0].tool_calls![0].function.arguments);
      expect(args.command).toBe(
        `curl -H "Authorization: Bearer ${LONG_JWT}" https://api.example.com/data`
      );
      // And the original message should be unchanged
      expect(messages[0].tool_calls![0].function.arguments).toContain("{{jwt_token}}");
    });

    it("should allow reusing the JWT variable across multiple tool calls without repeating it", async () => {
      setVariableFunction("jwt_token", LONG_JWT);

      // Simulate multiple tool calls all using {{jwt_token}} - LLM never outputs full JWT again
      const toolCallMessages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "execCommand",
                arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer {{jwt_token}}" https://api.example.com/users' }),
              },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: {
                name: "execCommand",
                arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer {{jwt_token}}" https://api.example.com/posts' }),
              },
            },
          ],
        },
      ];

      const processor = customVariables.createProcessor();
      const modifiedMessages = [...toolCallMessages];
      await processor(toolCallMessages, modifiedMessages);

      // Both tool calls should have the full JWT
      const args1 = JSON.parse(modifiedMessages[0].tool_calls![0].function.arguments);
      const args2 = JSON.parse(modifiedMessages[1].tool_calls![0].function.arguments);

      expect(args1.command).toContain(LONG_JWT);
      expect(args2.command).toContain(LONG_JWT);

      // Original messages should still have the placeholder
      expect(toolCallMessages[0].tool_calls![0].function.arguments).toContain("{{jwt_token}}");
      expect(toolCallMessages[1].tool_calls![0].function.arguments).toContain("{{jwt_token}}");
    });

  describe("storeToolCallToVariable privacy proof", () => {
    /**
     * This test proves that when an LLM uses storeToolCallToVariable to load
     * a sensitive value (e.g. a JWT from a file), the LLM *never* sees the
     * actual value in any message. The tool response only says
     * "stored in variable X" - the raw secret stays server-side in the
     * variable storage, and the LLM uses {{jwt_token}} as a placeholder.
     */
    let storeToolCallFunction: (
      varName: string,
      toolName: string,
      toolArgs: string
    ) => Promise<string>;
    let setVariableFunction: (name: string, contents: any) => string;

    beforeEach(() => {
      const addFunctionsCalls = mockToolsService.addFunctions.mock.calls;
      storeToolCallFunction = addFunctionsCalls.find(
        (call) => call[0].storeToolCallToVariable
      )![0].storeToolCallToVariable;
      setVariableFunction = addFunctionsCalls.find(
        (call) => call[0].setVariable
      )![0].setVariable;
    });

    it("should store JWT from a file without the LLM ever seeing the value", async () => {
      // Simulate a tool that reads the JWT file (like execCommand cat .knowhow/.jwt)
      const jwtContent = fs.readFileSync(`${__dirname}/../fixtures/fake-secret.txt`, "utf-8").trim();

      // The tool returns the file contents - but only to storeToolCallToVariable, not to the LLM
      mockToolsService.callTool.mockResolvedValue(jwtContent as any);

      // LLM calls: storeToolCallToVariable("jwt_token", "execCommand", '{"command":"cat .knowhow/.jwt"}')
      const toolResponse = await storeToolCallFunction(
        "jwt_token",
        "execCommand",
        JSON.stringify({ command: "cat tests/fixtures/fake-secret.txt" })
      );

      // The LLM only sees this confirmation message - NOT the JWT value itself
      expect(toolResponse).toBe(
        'Tool call result for "execCommand" has been stored in variable "jwt_token".'
      );
      expect(toolResponse).not.toContain(jwtContent);
      expect(toolResponse).not.toContain("eyJ"); // No JWT content in the response

      // The JWT IS stored internally and can be substituted into future tool calls
      const processor = customVariables.createProcessor();

      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_curl",
              type: "function",
              function: {
                name: "execCommand",
                // LLM uses placeholder - never outputs the actual JWT
                arguments: JSON.stringify({
                  command: 'curl -H "Authorization: Bearer {{jwt_token}}" https://api.example.com',
                }),
              },
            },
          ],
        },
      ];

      const modifiedMessages = [...messages];
      await processor(messages, modifiedMessages);

      // The actual JWT is injected at execution time
      const args = JSON.parse(modifiedMessages[0].tool_calls![0].function.arguments);
      expect(args.command).toContain(jwtContent);

      // But the original message still has the placeholder (LLM never saw the JWT)
      expect(messages[0].tool_calls![0].function.arguments).toContain("{{jwt_token}}");
      expect(messages[0].tool_calls![0].function.arguments).not.toContain(jwtContent);
    });

    it("should prove the full storeToolCallToVariable flow with real JWT file", async () => {
      // Use a fake secret file instead of a real JWT, to prove the secret is never exposed
      const fakePath = `${__dirname}/../fixtures/fake-secret.txt`;
      const fakeSecret = fs.readFileSync(fakePath, "utf-8").trim();

      // Simulate the execCommand tool returning the JWT file contents
      mockToolsService.callTool.mockResolvedValue(fakeSecret as any);

      // Step 1: LLM stores JWT via storeToolCallToVariable - only gets a confirmation back
      const storeResponse = await storeToolCallFunction(
        "jwt_token",
        "execCommand",
        JSON.stringify({ command: `cat ${fakePath}` })
      );

      // LLM message history only contains this - not the JWT
      expect(storeResponse).toContain('stored in variable "jwt_token"');
      expect(storeResponse).not.toContain(fakeSecret);

      // Step 2: LLM uses {{jwt_token}} in subsequent curl calls
      const processor = customVariables.createProcessor();
      const curlMessages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_api1",
              type: "function",
              function: {
                name: "execCommand",
                arguments: JSON.stringify({
                  command: 'curl -H "Authorization: Bearer {{jwt_token}}" https://api.example.com/users',
                }),
              },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_api2",
              type: "function",
              function: {
                name: "execCommand",
                arguments: JSON.stringify({
                  command: 'curl -H "Authorization: Bearer {{jwt_token}}" https://api.example.com/posts',
                }),
              },
            },
          ],
        },
      ];

      const modifiedMessages = [...curlMessages];
      await processor(curlMessages, modifiedMessages);

      // Both calls get the real JWT injected
      const args1 = JSON.parse(modifiedMessages[0].tool_calls![0].function.arguments);
      const args2 = JSON.parse(modifiedMessages[1].tool_calls![0].function.arguments);
      expect(args1.command).toContain(fakeSecret);
      expect(args2.command).toContain(fakeSecret);
      // Original messages still have placeholder - JWT never appeared in LLM messages
      expect(curlMessages[0].tool_calls![0].function.arguments).not.toContain(fakeSecret);
      expect(curlMessages[1].tool_calls![0].function.arguments).not.toContain(fakeSecret);
    });
  });

  describe("createRepetitionHintProcessor", () => {
    it("should append a hint when a large string is repeated across multiple tool calls", async () => {
      const longString = "x".repeat(100);
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "toolA", arguments: JSON.stringify({ token: longString }) } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "toolA", arguments: JSON.stringify({ token: longString }) } }],
        },
      ];

      const processor = customVariables.createRepetitionHintProcessor({ minLength: 50, minRepetitions: 2 });
      const modified = JSON.parse(JSON.stringify(messages));
      await processor(messages, modified);

      // A hint message should be appended
      const hint = modified[modified.length - 1];
      expect(hint.role).toBe("user");
      expect(hint.content).toContain("large repetitions");
      expect(hint.content).toContain("toolA");
      expect(hint.content).toContain("setVariable");
      expect(hint.content).toContain("storeToolCallToVariable");
    });

    it("should not append a hint when strings are short", async () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "toolA", arguments: JSON.stringify({ token: "short" }) } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "toolA", arguments: JSON.stringify({ token: "short" }) } }],
        },
      ];

      const processor = customVariables.createRepetitionHintProcessor({ minLength: 50, minRepetitions: 2 });
      const modified = JSON.parse(JSON.stringify(messages));
      await processor(messages, modified);

      // No hint should be appended - length of messages unchanged
      expect(modified.length).toBe(messages.length);
    });

    it("should not append a hint when a large string appears only once", async () => {
      const longString = "y".repeat(100);
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "toolB", arguments: JSON.stringify({ value: longString }) } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "toolB", arguments: JSON.stringify({ value: "something_different_entirely" }) } }],
        },
      ];

      const processor = customVariables.createRepetitionHintProcessor({ minLength: 50, minRepetitions: 2 });
      const modified = JSON.parse(JSON.stringify(messages));
      await processor(messages, modified);
      expect(modified.length).toBe(messages.length);
    });

    it("should list all tool names that use repeated values", async () => {
      const longString = "z".repeat(100);
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "toolX", arguments: JSON.stringify({ auth: longString }) } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "toolY", arguments: JSON.stringify({ auth: longString }) } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c3", type: "function", function: { name: "toolZ", arguments: JSON.stringify({ auth: longString }) } }],
        },
      ];
      const processor = customVariables.createRepetitionHintProcessor({ minLength: 50, minRepetitions: 2 });
      const modified = JSON.parse(JSON.stringify(messages));
      await processor(messages, modified);
      const hint = modified[modified.length - 1];
      expect(hint.content).toContain("toolX");
      expect(hint.content).toContain("toolY");
      expect(hint.content).toContain("toolZ");
    });

    it("should use default options when none provided", async () => {
      const longString = "a".repeat(60); // > 50 default minLength
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "myTool", arguments: JSON.stringify({ key: longString }) } }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "myTool", arguments: JSON.stringify({ key: longString }) } }],
        },
      ];
      const processor = customVariables.createRepetitionHintProcessor(); // default options
      const modified = JSON.parse(JSON.stringify(messages));
      await processor(messages, modified);
      const hint = modified[modified.length - 1];
      expect(hint.role).toBe("user");
      expect(hint.content).toContain("myTool");
    });

    it("should detect repeated substrings embedded within different larger strings", async () => {
      // Simulate the JWT-in-curl-command pattern:
      // Each command is unique but all contain the same JWT substring
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJmYWtlLXVzZXItaWQifQ.FAKE_SIGNATURE_DO_NOT_USE";
      const messages: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "c1", type: "function",
            function: { name: "execCommand", arguments: JSON.stringify({ command: `curl -H 'Authorization: Bearer ${jwt}' https://api.example.com/endpoint-one` }) }
          }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "c2", type: "function",
            function: { name: "execCommand", arguments: JSON.stringify({ command: `curl -H 'Authorization: Bearer ${jwt}' https://api.example.com/endpoint-two --data '{"key":"value"}'` }) }
          }],
        },
      ];

      const processor = customVariables.createRepetitionHintProcessor({ minLength: 50, minRepetitions: 2, minSubstringLength: 50 });
      const modified = JSON.parse(JSON.stringify(messages));
      await processor(messages, modified);

      // Should have detected the JWT appearing in both commands and added a hint
      expect(modified.length).toBe(3);
      const hint = modified[modified.length - 1];
      expect(hint.role).toBe("user");
      expect(hint.content).toContain("execCommand");
      expect(hint.content).toContain("setVariable");
    });
  });
  });
});
