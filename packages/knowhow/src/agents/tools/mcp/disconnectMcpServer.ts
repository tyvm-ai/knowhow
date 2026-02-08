import { services } from "../../../services";
import { McpService } from "../../../services/Mcp";
import { ToolsService } from "../../../services/Tools";

export async function disconnectMcpServer(serverName: string) {
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();
  const Mcp = context.Mcp;

  if (!Mcp) {
    return {
      success: false,
      error: "MCP service not available in context",
      toolsRemoved: [],
    };
  }

  if (!serverName) {
    return {
      success: false,
      error: "serverName parameter is required",
      toolsRemoved: [],
    };
  }

  const result = await Mcp.disconnectSingle(serverName);

  // If disconnection was successful and tools were removed, update the ToolsService
  if (result.success && result.toolsRemoved.length > 0) {
    // Remove tools from the current ToolsService instance
    toolService.tools = toolService.tools.filter(
      (tool) => !result.toolsRemoved.includes(tool.function.name)
    );
  }

  return result;
}
