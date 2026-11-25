/**
 * Deferred tools through the Knowhow proxy.
 *
 * When the agent's provider (e.g. "anthropic") isn't registered, requests fall
 * back to the Knowhow proxy client and capabilities are judged as served by
 * "knowhow", which forwards the model's own capabilities. The proxy client
 * only sends deferred tools / `_tool_changes` markers when the server
 * advertises `capabilities.toolChanges` (older servers strip `defer_loading`,
 * which sent ~190k tokens of tool definitions on every request), and the
 * AIClient flattens them for any model that can't render them.
 */
import { BaseAgent } from "../../src/agents/base/base";
import { AIClient } from "../../src/clients";
import { getModelInfo } from "../../src/clients/pricing/modelInfo";
import { LazyToolsService } from "../../src/services/LazyToolsService";
import { KnowhowGenericClient } from "../../src/clients/knowhow";
import { Message, Tool } from "../../src/clients/types";

class TestAgent extends BaseAgent {
  name = "TestAgent";
  description = "test";
  async getInitialMessages(): Promise<any[]> {
    return [];
  }
}

const tool = (name: string, defer = false): Tool => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
  ...(defer && { defer_loading: true }),
});

const deferredRequest = (model: string) => ({
  model,
  messages: [
    { role: "user", content: "hi" },
    { role: "system", content: "Tool availability changed", _tool_changes: { add: ["other"] } },
  ] as Message[],
  tools: [tool("finalAnswer"), tool("mcp_1_big", true), tool("other", true)],
});

describe("model info for proxy-served agents", () => {
  const events: any = { setListener: () => {}, emit: () => {}, on: () => {} };

  function agentWith(clients: Record<string, any>, client: any, model = "claude-opus-5-5") {
    // Minimal AIClient stand-in (constructing AIClient registers providers).
    const service: any = {
      clients,
      getModelInfo: (provider: string, m: string) => getModelInfo(m, provider),
    };
    const agent = new TestAgent({
      Clients: service,
      Events: events,
      Tools: new LazyToolsService(),
    } as any);
    agent.setProvider("anthropic");
    agent.setModel(model);
    agent.setClient(client);
    return agent;
  }

  it("judges capabilities by the proxy, which forwards the model's own", () => {
    const proxy = { createChatCompletion: jest.fn() };
    const agent = agentWith({ knowhow: proxy }, proxy);
    expect(agent.getModelInfo().servedBy).toBe("knowhow");
    expect(agent.supportsToolAdditions()).toBe(true);

    const sonnet5 = agentWith({ knowhow: proxy }, proxy, "claude-sonnet-5");
    expect(sonnet5.supportsToolAdditions()).toBe(false);
  });

  it("keeps native capabilities when the named provider serves the model", () => {
    const direct = { createChatCompletion: jest.fn() };
    const agent = agentWith({ anthropic: direct }, direct);
    expect(agent.getModelInfo().servedBy).toBe("anthropic");
    expect(agent.supportsToolAdditions()).toBe(true);
  });
});

describe("KnowhowGenericClient tool changes", () => {
  function proxyClient(modelsData: any) {
    const client = new KnowhowGenericClient("http://example.invalid", "jwt");
    const send = jest.fn().mockResolvedValue({ data: { choices: [] } });
    const getModels = jest.fn().mockResolvedValue({ data: modelsData });
    (client as any).client = { createChatCompletion: send, getModels };
    return { client, send, getModels };
  }

  it("forwards deferred tools and markers when the server advertises support", async () => {
    const { client, send, getModels } = proxyClient({
      data: [],
      capabilities: { toolChanges: true },
    });
    await client.createChatCompletion(deferredRequest("claude-opus-5-5"));
    await client.createChatCompletion(deferredRequest("claude-opus-5-5"));
    const sent = send.mock.calls[0][0];
    expect(sent.tools.map((t: Tool) => !!t.defer_loading)).toEqual([false, true, true]);
    expect(sent.messages.some((m: Message) => m._tool_changes)).toBe(true);
    expect(getModels).toHaveBeenCalledTimes(1); // capability is memoized
  });

  it("flattens to the enabled tools for servers without the capability", async () => {
    const { client, send } = proxyClient({ data: [] });
    await client.createChatCompletion(deferredRequest("claude-opus-5-5"));
    const sent = send.mock.calls[0][0];
    expect(sent.tools.map((t: Tool) => t.function.name)).toEqual(["finalAnswer", "other"]);
    expect(sent.tools.some((t: Tool) => t.defer_loading)).toBe(false);
    expect(sent.messages.some((m: Message) => m._tool_changes)).toBe(false);
  });

  it("doesn't query capabilities for plain requests", async () => {
    const { client, send, getModels } = proxyClient({ data: [] });
    await client.createChatCompletion({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [tool("finalAnswer")],
    });
    expect(getModels).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("AIClient.createCompletion tool changes", () => {
  function aiClientWith(provider: string) {
    const ai = new AIClient();
    const send = jest.fn().mockResolvedValue({ choices: [] });
    ai.clients = { [provider]: { createChatCompletion: send } as any };
    ai.clientModels = { [provider]: ["claude-opus-5-5", "claude-sonnet-5", "gemini-4-neon"] };
    return { ai, send };
  }

  it("passes deferred tools through for models with tool additions", async () => {
    const { ai, send } = aiClientWith("anthropic");
    await ai.createCompletion("anthropic", deferredRequest("claude-opus-5-5"));
    expect(send.mock.calls[0][0].tools.filter((t: Tool) => t.defer_loading)).toHaveLength(2);
  });

  it("flattens them for models/providers without tool additions", async () => {
    for (const [provider, model] of [
      ["anthropic", "claude-sonnet-5"],
      ["google", "gemini-4-neon"],
    ]) {
      const { ai, send } = aiClientWith(provider);
      await ai.createCompletion(provider, deferredRequest(model));
      const sent = send.mock.calls[0][0];
      expect(sent.tools.map((t: Tool) => t.function.name)).toEqual(["finalAnswer", "other"]);
      expect(sent.messages.some((m: Message) => m._tool_changes)).toBe(false);
    }
  });
});
