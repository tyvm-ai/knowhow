import {
  callToolByMethod,
  findMcpToolCandidates,
  normalizeMcpResult,
  resolveToolName,
  McpTimeoutError,
  McpToolNotFoundError,
} from "../../../src/services/McpCallByMethod";
import { ToolsService } from "../../../src/services/Tools";
import { McpService } from "../../../src/services/Mcp";

const NAMES = [
  "readFile",
  "mcp_0_browser_browser_tabs",
  "mcp_1_other_server_browser_tabs",
  "mcp_1_other_server_snapshot",
];

describe("findMcpToolCandidates", () => {
  it("prefers an exact name", () => {
    expect(findMcpToolCandidates(NAMES, "readFile")).toEqual(["readFile"]);
  });
  it("matches by suffix, returning all candidates in order", () => {
    expect(findMcpToolCandidates(NAMES, "browser_tabs")).toEqual([
      "mcp_0_browser_browser_tabs",
      "mcp_1_other_server_browser_tabs",
    ]);
  });
  it("restricts to a server (case/space-insensitive)", () => {
    expect(findMcpToolCandidates(NAMES, "browser_tabs", "Other Server")).toEqual([
      "mcp_1_other_server_browser_tabs",
    ]);
    expect(findMcpToolCandidates(NAMES, "snapshot", "browser")).toEqual([]);
  });
  it("returns [] when nothing matches", () => {
    expect(findMcpToolCandidates(NAMES, "nope")).toEqual([]);
  });
});

describe("normalizeMcpResult", () => {
  it("joins text content, parses json, passes isError", () => {
    const r = normalizeMcpResult({
      content: [{ type: "text", text: '{"a":1}' }, { type: "image", data: "x" }],
      isError: false,
    });
    expect(r).toEqual({ text: '{"a":1}', json: { a: 1 }, isError: false });
    expect(
      normalizeMcpResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], isError: true })
    ).toEqual({ text: "a\nb", isError: true });
  });
  it("accepts plain strings and empty values", () => {
    expect(normalizeMcpResult("hello")).toEqual({ text: "hello", isError: false });
    expect(normalizeMcpResult(undefined)).toEqual({ text: "", isError: false });
  });
});

describe("resolveToolName", () => {
  it("resolves exact, then suffix, then glob", () => {
    expect(resolveToolName(NAMES, "readFile")).toBe("readFile");
    expect(resolveToolName(NAMES, "snapshot")).toBe("mcp_1_other_server_snapshot");
    expect(resolveToolName(NAMES, "mcp_0_*")).toBe("mcp_0_browser_browser_tabs");
    expect(resolveToolName(NAMES, "zzz")).toBeUndefined();
  });
});

describe("callToolByMethod", () => {
  const source = (invoke: (n: string, a: object) => Promise<unknown>) => ({
    toolNames: () => NAMES,
    invoke,
  });

  it("calls the first match and normalises the result", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: [{ type: "text", text: "[1]" }] });
    const r = await callToolByMethod(source(invoke), "browser_tabs", { action: "list" });
    expect(invoke).toHaveBeenCalledWith("mcp_0_browser_browser_tabs", { action: "list" });
    expect(r).toMatchObject({ text: "[1]", json: [1], isError: false, toolName: "mcp_0_browser_browser_tabs" });
    expect(r.raw).toEqual({ content: [{ type: "text", text: "[1]" }] });
  });

  it("honours opts.server", async () => {
    const invoke = jest.fn().mockResolvedValue("ok");
    const r = await callToolByMethod(source(invoke), "browser_tabs", {}, { server: "other_server" });
    expect(r.toolName).toBe("mcp_1_other_server_browser_tabs");
  });

  it("reports isError without throwing", async () => {
    const r = await callToolByMethod(
      source(async () => ({ content: [{ type: "text", text: "bad" }], isError: true })),
      "snapshot"
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("bad");
  });

  it("rejects with McpToolNotFoundError", async () => {
    await expect(callToolByMethod(source(jest.fn()), "missing")).rejects.toBeInstanceOf(McpToolNotFoundError);
    await expect(callToolByMethod(source(jest.fn()), "snapshot", {}, { server: "x" })).rejects.toThrow(/server "x"/);
  });

  it("rejects with McpTimeoutError", async () => {
    const p = callToolByMethod(source(() => new Promise(() => undefined)), "snapshot", {}, { timeoutMs: 10 });
    await expect(p).rejects.toBeInstanceOf(McpTimeoutError);
  });

  it("propagates invoke errors", async () => {
    await expect(
      callToolByMethod(source(async () => { throw new Error("kaput"); }), "snapshot")
    ).rejects.toThrow("kaput");
  });
});

describe("ToolsService.callByMethod", () => {
  it("resolves wrapped MCP tools by suffix through registered functions", async () => {
    const tools = new ToolsService();
    const fn = jest.fn().mockResolvedValue({ content: [{ type: "text", text: "tabs" }] });
    tools.defineTools(
      [{ type: "function", function: { name: "mcp_0_browser_browser_tabs", description: "", parameters: { type: "object", properties: {}, required: [] } } } as any],
      { mcp_0_browser_browser_tabs: fn }
    );
    const r = await tools.callByMethod("browser_tabs", { action: "list" });
    expect(r.text).toBe("tabs");
    expect(fn).toHaveBeenCalledWith({ action: "list" });
    await expect(tools.callByMethod("nope")).rejects.toBeInstanceOf(McpToolNotFoundError);
  });
});

describe("McpService.callByMethod", () => {
  it("resolves against its own tool list and passes the timeout through", async () => {
    const mcp = new McpService();
    mcp.tools = [
      { type: "function", function: { name: "mcp_0_srv_ping", description: "", parameters: {} } } as any,
    ];
    const call = jest.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] });
    const spy = jest.spyOn(mcp, "getFunction").mockReturnValue(call as any);
    const r = await mcp.callByMethod("ping", { x: 1 }, { timeoutMs: 1234 });
    expect(spy).toHaveBeenCalledWith("mcp_0_srv_ping", 1234);
    expect(call).toHaveBeenCalledWith({ x: 1 });
    expect(r.text).toBe("pong");
  });
});
