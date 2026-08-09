import { LazyToolsService } from "../../../src/services/LazyToolsService";
import { Tool } from "../../../src/clients/types";

function tool(name: string): Tool {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

describe("LazyToolsService persisted tool restoration", () => {
  test("replaces pattern state with the exact saved tool list", () => {
    const tools = new LazyToolsService();
    tools.addTools([tool("alpha"), tool("beta"), tool("finalAnswer")]);
    tools.enableTools(["*"]);
    tools.disableTools(["alpha"]);

    tools.restoreEnabledTools(["alpha", "finalAnswer"]);

    expect(tools.getTools().map((entry) => entry.function.name).sort()).toEqual([
      "alpha",
      "finalAnswer",
    ]);
  });

  test("calls a registered hidden tool without making it prompt-visible", async () => {
    const tools = new LazyToolsService();
    tools.addTools([tool("hiddenTool")]);
    tools.setFunction("hiddenTool", ({ value }: { value: string }) => `got:${value}`);

    expect(tools.getToolNames()).not.toContain("hiddenTool");
    expect(tools.getFunctionNames()).toContain("hiddenTool");

    const result = await tools.callTool({
      id: "hidden-call",
      type: "function",
      function: {
        name: "hiddenTool",
        arguments: JSON.stringify({ value: "test" }),
      },
    });

    expect(result.functionResp).toBe("got:test");
    expect(tools.getToolNames()).not.toContain("hiddenTool");
    expect(tools.listAvailableTools()).toMatchObject({
      disabled: expect.arrayContaining(["hiddenTool"]),
    });
  });
});
