/**
 * BaseAgent wiring for mid-conversation tool changes: with a client that
 * supports tool additions, the tools array stays fixed (deferred catalog) and
 * enables are appended as `_tool_changes` markers; otherwise the classic
 * enabled-tools request is sent with markers stripped.
 */
import { BaseAgent } from "../../src/agents/base/base";
import { LazyToolsService } from "../../src/services/LazyToolsService";
import { Message, Tool } from "../../src/clients/types";

const tool = (name: string): Tool => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

class TestAgent extends BaseAgent {
  name = "TestAgent";
  description = "test";
  async getInitialMessages(): Promise<any[]> {
    return [];
  }
  request(messages: Message[]) {
    return this.prepareToolRequest({ messages } as any);
  }
}

function setup(supported: boolean) {
  const tools = new LazyToolsService();
  tools.addTools([tool("readFile"), tool("writeFile")]);
  const events: any = { setListener: () => {}, emit: () => {}, on: () => {} };
  const agent = new TestAgent({ Tools: tools, Events: events } as any);
  agent.setModel("m");
  agent.setClient({} as any);
  jest
    .spyOn(agent, "getModelInfo")
    .mockReturnValue({ info: { toolAdditions: supported } } as any);
  return { agent, tools };
}

const names = (tools: Tool[]) =>
  tools.map((t) => `${t.function.name}${t.defer_loading ? "*" : ""}`);

describe("BaseAgent tool changes", () => {
  it("keeps the tools array fixed and appends a marker on enable", () => {
    const { agent, tools } = setup(true);
    let thread: Message[] = [{ role: "user", content: "go" }];

    thread = agent.syncToolChanges(thread);
    expect(thread).toHaveLength(1); // nothing changed yet
    const first = agent.request(thread);
    expect(names(first.tools!)).toEqual([
      "listAvailableTools",
      "enableTools",
      "disableTools",
      "readFile*",
      "writeFile*",
    ]);

    tools.enableTools(["readFile"]);
    thread.push({ role: "tool", tool_call_id: "1", content: "ok" });
    thread = agent.syncToolChanges(thread);
    expect(thread[thread.length - 1]._tool_changes).toEqual({
      add: ["readFile"],
    });
    // Idempotent: the marker already covers the change.
    expect(agent.syncToolChanges(thread)).toBe(thread);

    const second = agent.request(thread);
    expect(second.tools).toEqual(first.tools);
    expect(second.messages).toBe(thread);

    tools.disableTools(["readFile"]);
    thread.push({ role: "user", content: "next" });
    thread = agent.syncToolChanges(thread);
    expect(thread[thread.length - 1]._tool_changes).toEqual({
      remove: ["readFile"],
    });
  });

  it("re-adds tools when compaction dropped earlier markers", () => {
    const { agent, tools } = setup(true);
    agent.request([{ role: "user", content: "go" }]); // fix the baseline
    tools.enableTools(["readFile"]);
    const compacted = agent.syncToolChanges([
      { role: "user", content: "summary" },
    ]);
    expect(compacted[1]._tool_changes).toEqual({ add: ["readFile"] });
  });

  it("does not place a marker after an assistant turn", () => {
    const { agent, tools } = setup(true);
    agent.request([{ role: "user", content: "go" }]);
    tools.enableTools(["readFile"]);
    const thread: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "hi" },
    ];
    expect(agent.syncToolChanges(thread)).toBe(thread);
  });

  it("sends enabled tools and strips markers when unsupported", () => {
    const { agent, tools } = setup(false);
    tools.enableTools(["readFile"]);
    const thread: Message[] = [
      { role: "user", content: "go" },
      { role: "system", content: "x", _tool_changes: { add: ["readFile"] } },
    ];
    expect(agent.syncToolChanges(thread)).toBe(thread);
    const req = agent.request(thread);
    expect(names(req.tools!)).toContain("readFile");
    expect(req.tools!.some((t) => t.defer_loading)).toBe(false);
    expect(req.messages).toHaveLength(1);
  });
});
