import { services } from "../../../services";
import { McpService } from "../../../services/Mcp";
import { ToolsService } from "../../../services/Tools";

export async function connectMcpServer(
  serverName: string,
  timeout: number = 30000
) {
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();
  const Mcp = context.Mcp;

  if (!Mcp) {
    return {
      success: false,
      error: "MCP service not available in context",
      toolsAdded: [],
    };
  }

  if (!serverName) {
    return {
      success: false,
      error: "serverName parameter is required",
      toolsAdded: [],
    };
  }

  const result = await Mcp.connectSingle(serverName, timeout);

  // If connection was successful and tools were added, register them with the ToolsService
  if (result.success && result.toolsAdded.length > 0) {
    await Mcp.addTools(toolService);
  }

  return result;
}
