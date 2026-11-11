import { LazyToolsService } from "../../src/services/LazyToolsService";
import { TokenCompressor } from "../../src/processors/TokenCompressor";
import { Message } from "../../src/clients/types";

describe("expandTokens availability for lazy-mode agents", () => {
  it("is visible without enableTools once a TokenCompressor is registered", () => {
    const tools = new LazyToolsService();
    expect(tools.getTools().map((t) => t.function.name)).not.toContain(
      "expandTokens"
    );
    new TokenCompressor(tools);
    expect(tools.getTools().map((t) => t.function.name)).toContain(
      "expandTokens"
    );
  });

  it("cannot be disabled via disableTools while pinned", () => {
    const tools = new LazyToolsService();
    new TokenCompressor(tools);
    tools.disableTools(["expandTokens", "*"]);
    expect(tools.getTools().map((t) => t.function.name)).toContain(
      "expandTokens"
    );
  });

  it("can expand a placeholder without any enableTools call", async () => {
    const tools = new LazyToolsService();
    const compressor = new TokenCompressor(tools);
    const msg: Message = {
      role: "tool",
      tool_call_id: "t1",
      name: "execCommand",
      content: "line\n".repeat(30000),
    };
    await compressor.compressMessage(msg);
    const key = /Key: (compressed_\w+)/.exec(msg.content as string)?.[1];
    expect(key).toBeTruthy();
    const out = await tools.callTool({
      id: "x",
      type: "function",
      function: { name: "expandTokens", arguments: JSON.stringify({ key }) },
    } as any);
    expect(JSON.stringify(out)).toContain("line");
  });

  it("does not compress mid-size readFile results", async () => {
    const compressor = new TokenCompressor();
    const content = "const a = 1;\n".repeat(2000); // ~26k chars, ~6.5k tokens
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1" } as any] },
      { role: "tool", tool_call_id: "t1", name: "readFile", content },
    ];
    await compressor.createProcessor()(msgs, msgs);
    expect(msgs[2].content).toBe(content);
  });
});
