import { services } from "../../../services";
import { McpService } from "../../../services/Mcp";
import { ToolsService } from "../../../services/Tools";

export async function listAvailableMcpServers() {
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const context = toolService.getContext();
  const Mcp = context.Mcp;

  if (!Mcp) {
    return {
      error: "MCP service not available in context",
      servers: [],
    };
  }

  const servers = Mcp.getAvailableServers();

  return {
    servers,
    summary: `Found ${servers.length} configured MCP server(s). ${
      servers.filter((s) => s.connected).length
    } connected, ${servers.filter((s) => !s.connected).length} disconnected.`,
  };
}
