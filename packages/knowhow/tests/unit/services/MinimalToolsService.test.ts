/**
 * Tests for MinimalToolsService and MinimalToolsMessageProcessor.
 *
 * Key scenarios:
 * 1. Base tools are always in the visible tools array (cache-stable).
 * 2. Extended tools added via addTools() are NOT in the visible array.
 * 3. callTool dispatches to any tool in the catalog by name.
 * 4. inspectTools returns schemas from the full catalog.
 * 5. MinimalToolsMessageProcessor unwraps callTool(name, args) in the last
 *    assistant message's tool_calls.
 * 6. Unwrapping callTool("finalAnswer", ...) → finalAnswer so the agent
 *    terminates correctly.
 * 7. Unwrapping callTool("testTool123", ...) → testTool123 so a custom
 *    required tool is satisfied.
 * 8. Multiple callTool entries in one message are all unwrapped.
 * 9. Only the last assistant message is rewritten (older messages untouched).
 */

// ── Mocks (must come before any imports that touch config/clients) ──────────
jest.mock("../../../src/config", () => ({
  getConfig: jest.fn(),
  getGlobalConfig: jest.fn(),
  getConfigSync: jest.fn().mockReturnValue({}),
}));

jest.mock("../../../src/clients", () => ({
  AIClient: jest.fn(),
  Clients: jest.fn(),
}));

jest.mock("../../../src/services", () => ({
  services: jest.fn().mockReturnValue({
    Clients: {},
    Plugins: { listPlugins: jest.fn().mockReturnValue([]) },
    Agents: {},
    Tools: {},
  }),
}));

// ── Imports ──────────────────────────────────────────────────────────────────
import { MinimalToolsService } from "../../../src/services/MinimalToolsService";
import { MinimalToolsMessageProcessor } from "../../../src/processors/MinimalToolsMessageProcessor";
import { Tool } from "../../../src/clients/types";
import { Message } from "../../../src/clients/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTool(name: string): Tool {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: {
        type: "object",
        positional: false,
        properties: {
          input: { type: "string", description: "input" },
        },
        required: [],
      },
    },
  };
}

function makeCallToolMessage(
  toolName: string,
  args: Record<string, any>,
  id = "tc_1"
): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: "callTool",
          arguments: JSON.stringify({ name: toolName, args }),
        },
      },
    ],
  } as unknown as Message;
}

// ── MinimalToolsService ───────────────────────────────────────────────────────

describe("MinimalToolsService", () => {
  let service: MinimalToolsService;

  beforeEach(() => {
    service = new MinimalToolsService();
  });

  test("base tools are always visible", () => {
    const names = service.getTools().map((t) => t.function.name);
    expect(names).toContain("finalAnswer");
    expect(names).toContain("callTool");
    expect(names).toContain("inspectTools");
  });

  test("extended tools added via addTools() are NOT in visible tools", () => {
    const extended = makeTool("readFile");
    service.addTools([extended]);

    const visibleNames = service.getTools().map((t) => t.function.name);
    expect(visibleNames).not.toContain("readFile");
  });

  test("extended tools appear in getAllTools()", () => {
    const extended = makeTool("readFile");
    service.addTools([extended]);

    const allNames = service.getAllTools().map((t) => t.function.name);
    expect(allNames).toContain("readFile");
    expect(allNames).toContain("finalAnswer");
  });

  test("visible tools array is stable after adding extended tools", () => {
    const before = service.getTools().map((t) => t.function.name);
    service.addTools([makeTool("writeFile"), makeTool("patchFile")]);
    const after = service.getTools().map((t) => t.function.name);
    expect(before).toEqual(after);
  });

  test("duplicate extended tools are not added twice", () => {
    service.addTools([makeTool("readFile")]);
    service.addTools([makeTool("readFile")]);
    const allNames = service.getAllTools().map((t) => t.function.name);
    const count = allNames.filter((n) => n === "readFile").length;
    expect(count).toBe(1);
  });

  test("inspectTools returns schema for all tools when no patterns given", () => {
    service.addTools([makeTool("readFile"), makeTool("writeFile")]);
    const result = service.callTool(
      {
        id: "tc_inspect",
        type: "function",
        function: { name: "inspectTools", arguments: JSON.stringify({}) },
      },
      service.getToolNames()
    );
    // inspectTools is synchronous inside callTool, check via direct function call
    const fn = service.getFunction("inspectTools");
    expect(fn).toBeDefined();
    const schemas = fn.call(service) as any[];
    const names = schemas.map((s: any) => s.name);
    expect(names).toContain("readFile");
    expect(names).toContain("writeFile");
    expect(names).toContain("finalAnswer");
  });

  test("inspectTools filters by glob pattern", () => {
    service.addTools([makeTool("readFile"), makeTool("writeFile"), makeTool("patchFile")]);
    const fn = service.getFunction("inspectTools");
    const schemas = fn.call(service, ["*File"]) as any[];
    const names = schemas.map((s: any) => s.name);
    expect(names).toContain("readFile");
    expect(names).toContain("writeFile");
    expect(names).toContain("patchFile");
    expect(names).not.toContain("finalAnswer");
    expect(names).not.toContain("callTool");
  });

  test("callToolByName dispatches to an extended tool and returns response", async () => {
    const mockFn = jest.fn().mockResolvedValue("file contents");
    service.addTools([makeTool("readFile")]);
    service.addFunctions({ readFile: mockFn });

    const result = await service.callToolByName(
      {
        id: "tc_read",
        type: "function",
        function: { name: "readFile", arguments: JSON.stringify({ input: "path/to/file" }) },
      },
      "readFile"
    );

    expect(mockFn).toHaveBeenCalled();
    expect(result).toBe("file contents");
  });
});

// ── MinimalToolsMessageProcessor ─────────────────────────────────────────────

describe("MinimalToolsMessageProcessor", () => {
  let processor: MinimalToolsMessageProcessor;
  let processorFn: ReturnType<MinimalToolsMessageProcessor["createProcessor"]>;

  beforeEach(() => {
    processor = new MinimalToolsMessageProcessor();
    processorFn = processor.createProcessor();
  });

  function applyProcessor(messages: Message[]): Message[] {
    const original = JSON.parse(JSON.stringify(messages)) as Message[];
    const modified = JSON.parse(JSON.stringify(messages)) as Message[];
    processorFn(original, modified);
    return modified;
  }

  test("unwraps callTool(name, args) to the real tool call", () => {
    const messages: Message[] = [
      makeCallToolMessage("readFile", { filePath: "foo.ts" }, "tc_1"),
    ];

    const result = applyProcessor(messages);
    const lastMsg = result[result.length - 1];

    expect(lastMsg.tool_calls).toHaveLength(1);
    expect(lastMsg.tool_calls[0].function.name).toBe("readFile");
    expect(JSON.parse(lastMsg.tool_calls[0].function.arguments)).toEqual({
      filePath: "foo.ts",
    });
    // ID preserved
    expect(lastMsg.tool_calls[0].id).toBe("tc_1");
  });

  test("unwraps callTool('finalAnswer', ...) so agent terminates", () => {
    const messages: Message[] = [
      makeCallToolMessage("finalAnswer", { answer: "All done!" }, "tc_fa"),
    ];

    const result = applyProcessor(messages);
    const lastMsg = result[result.length - 1];

    expect(lastMsg.tool_calls[0].function.name).toBe("finalAnswer");
    expect(JSON.parse(lastMsg.tool_calls[0].function.arguments)).toEqual({
      answer: "All done!",
    });
  });

  test("unwraps callTool('testTool123', ...) so custom required tool is satisfied", () => {
    const messages: Message[] = [
      makeCallToolMessage("testTool123", { data: "value" }, "tc_custom"),
    ];

    const result = applyProcessor(messages);
    const lastMsg = result[result.length - 1];

    expect(lastMsg.tool_calls[0].function.name).toBe("testTool123");
    expect(JSON.parse(lastMsg.tool_calls[0].function.arguments)).toEqual({
      data: "value",
    });
  });

  test("unwraps multiple callTool entries in a single assistant message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc_a",
            type: "function",
            function: {
              name: "callTool",
              arguments: JSON.stringify({ name: "readFile", args: { filePath: "a.ts" } }),
            },
          },
          {
            id: "tc_b",
            type: "function",
            function: {
              name: "callTool",
              arguments: JSON.stringify({ name: "writeFile", args: { filePath: "b.ts", content: "hi" } }),
            },
          },
        ],
      } as unknown as Message,
    ];

    const result = applyProcessor(messages);
    const lastMsg = result[result.length - 1];

    expect(lastMsg.tool_calls).toHaveLength(2);
    expect(lastMsg.tool_calls[0].function.name).toBe("readFile");
    expect(lastMsg.tool_calls[1].function.name).toBe("writeFile");
    expect(JSON.parse(lastMsg.tool_calls[0].function.arguments)).toEqual({ filePath: "a.ts" });
    expect(JSON.parse(lastMsg.tool_calls[1].function.arguments)).toEqual({
      filePath: "b.ts",
      content: "hi",
    });
  });

  test("does NOT rewrite older assistant messages (only the last one)", () => {
    const messages: Message[] = [
      // older assistant message with callTool — should NOT be rewritten
      makeCallToolMessage("oldTool", { x: 1 }, "tc_old"),
      // tool result for that call
      {
        role: "tool",
        tool_call_id: "tc_old",
        name: "callTool",
        content: "some result",
      } as unknown as Message,
      // newest assistant message — should be rewritten
      makeCallToolMessage("finalAnswer", { answer: "done" }, "tc_new"),
    ];

    const result = applyProcessor(messages);

    // First assistant message should be unchanged (still "callTool")
    const firstAssistant = result[0];
    expect(firstAssistant.tool_calls[0].function.name).toBe("callTool");

    // Last assistant message should be rewritten
    const lastAssistant = result[result.length - 1];
    expect(lastAssistant.tool_calls[0].function.name).toBe("finalAnswer");
  });

  test("leaves non-callTool tool_calls unchanged", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc_direct",
            type: "function",
            function: {
              name: "inspectTools",
              arguments: JSON.stringify({ patterns: ["*"] }),
            },
          },
        ],
      } as unknown as Message,
    ];

    const result = applyProcessor(messages);
    const lastMsg = result[result.length - 1];

    expect(lastMsg.tool_calls[0].function.name).toBe("inspectTools");
  });

  test("skips messages with no tool_calls", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" } as Message,
      { role: "assistant", content: "I will help" } as Message,
    ];

    const result = applyProcessor(messages);
    expect(result[1].tool_calls).toBeUndefined();
  });

  test("mixed: callTool entries alongside direct tool calls are selectively unwrapped", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc_direct",
            type: "function",
            function: {
              name: "inspectTools",
              arguments: JSON.stringify({}),
            },
          },
          {
            id: "tc_wrapped",
            type: "function",
            function: {
              name: "callTool",
              arguments: JSON.stringify({ name: "readFile", args: { filePath: "x.ts" } }),
            },
          },
        ],
      } as unknown as Message,
    ];

    const result = applyProcessor(messages);
    const lastMsg = result[result.length - 1];

    expect(lastMsg.tool_calls).toHaveLength(2);
    // Direct call preserved
    expect(lastMsg.tool_calls[0].function.name).toBe("inspectTools");
    // Wrapped call unwrapped
    expect(lastMsg.tool_calls[1].function.name).toBe("readFile");
  });
});
