/**
 * Tests for the worker reloadConfig message handler.
 *
 * We test the core logic in isolation — simulating the "reloadConfig" message
 * arriving on the WebSocket and verifying that MCPs are torn down and
 * re-connected, and that the tool list is rebuilt from fresh config.
 */

import { McpService } from "../../src/services/Mcp";
import { ToolsService } from "../../src/services/Tools";

// ---------------------------------------------------------------------------
// Helpers: build the same reload logic that lives in worker.ts so we can
// test it in isolation without spinning up a real WebSocket server.
// ---------------------------------------------------------------------------

async function simulateReloadConfig(
  Mcp: McpService,
  Tools: ToolsService,
  mcpServer: { withTools: (tools: unknown[]) => void },
  getConfig: () => Promise<{ worker?: { allowedTools?: string[] } }>,
  toolsToUseRef: { value: unknown[] }
) {
  // This mirrors the handler in worker.ts
  const freshConfig = await getConfig();
  await Mcp.closeAll();
  await Mcp.connectToConfigured(Tools);
  const allowedToolNames =
    freshConfig.worker?.allowedTools ?? Tools.getToolNames();
  toolsToUseRef.value = Tools.getToolsByNames(allowedToolNames);
  mcpServer.withTools(toolsToUseRef.value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Worker reloadConfig handler", () => {
  let Mcp: McpService;
  let Tools: ToolsService;
  let mcpServer: { withTools: jest.Mock };
  let toolsToUseRef: { value: unknown[] };

  beforeEach(() => {
    Mcp = new McpService();
    Tools = new ToolsService();
    mcpServer = { withTools: jest.fn() };
    toolsToUseRef = { value: [] };

    // Spy on MCP methods
    jest.spyOn(Mcp, "closeAll").mockResolvedValue(undefined);
    jest.spyOn(Mcp, "connectToConfigured").mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should call closeAll() to tear down existing MCP connections", async () => {
    const getConfig = jest
      .fn()
      .mockResolvedValue({ worker: { allowedTools: [] } });

    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);

    expect(Mcp.closeAll).toHaveBeenCalledTimes(1);
  });

  it("should call connectToConfigured() to reconnect MCPs from fresh config", async () => {
    const getConfig = jest
      .fn()
      .mockResolvedValue({ worker: { allowedTools: [] } });

    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);

    expect(Mcp.connectToConfigured).toHaveBeenCalledWith(Tools);
  });

  it("should rebuild the tool list from allowedTools in fresh config", async () => {
    // Spy on getToolsByNames so we can track what names were requested
    const toolsByNamesSpy = jest
      .spyOn(Tools, "getToolsByNames")
      .mockReturnValue([{ function: { name: "execCommand" } }] as ReturnType<ToolsService["getToolsByNames"]>);

    const getConfig = jest
      .fn()
      .mockResolvedValue({ worker: { allowedTools: ["execCommand"] } });

    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);

    expect(toolsByNamesSpy).toHaveBeenCalledWith(["execCommand"]);
    expect(toolsToUseRef.value).toHaveLength(1);
  });

  it("should fall back to all tool names when allowedTools is not set", async () => {
    const allNames = ["execCommand", "readFile", "writeFileChunk"];
    jest.spyOn(Tools, "getToolNames").mockReturnValue(allNames);
    const toolsByNamesSpy = jest
      .spyOn(Tools, "getToolsByNames")
      .mockReturnValue([] as ReturnType<ToolsService["getToolsByNames"]>);

    // Config has no worker.allowedTools
    const getConfig = jest.fn().mockResolvedValue({});

    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);

    expect(toolsByNamesSpy).toHaveBeenCalledWith(allNames);
  });

  it("should call mcpServer.withTools() with the rebuilt tool list", async () => {
    const fakeTools = [{ function: { name: "readFile" } }] as ReturnType<ToolsService["getToolsByNames"]>;
    jest.spyOn(Tools, "getToolsByNames").mockReturnValue(fakeTools);

    const getConfig = jest
      .fn()
      .mockResolvedValue({ worker: { allowedTools: ["readFile"] } });

    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);

    expect(mcpServer.withTools).toHaveBeenCalledWith(fakeTools);
  });

  it("should re-read the config on every reload (not use stale config)", async () => {
    const getConfig = jest
      .fn()
      .mockResolvedValueOnce({ worker: { allowedTools: ["execCommand"] } })
      .mockResolvedValueOnce({ worker: { allowedTools: ["readFile", "writeFileChunk"] } });

    jest.spyOn(Tools, "getToolsByNames").mockReturnValue([]);

    // First reload
    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);
    // Second reload
    await simulateReloadConfig(Mcp, Tools, mcpServer, getConfig, toolsToUseRef);

    expect(getConfig).toHaveBeenCalledTimes(2);
    // Each reload should tear down and reconnect
    expect(Mcp.closeAll).toHaveBeenCalledTimes(2);
    expect(Mcp.connectToConfigured).toHaveBeenCalledTimes(2);
  });
});
