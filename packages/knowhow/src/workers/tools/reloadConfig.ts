import { Tool } from "../../clients/types";
import { getConfig } from "../../config";
import { McpServerService } from "../../services/McpServer";
import { McpService } from "../../services/Mcp";
import { ToolsService } from "../../services/Tools";

export interface ReloadConfigResult {
  success: boolean;
  toolCount: number;
  mcpCount: number;
  message: string;
}

/**
 * Factory that creates the reloadConfig tool with access to runtime services.
 * The tool re-reads the config from disk, reconnects all MCPs, and rebuilds
 * the active tool list — the same logic as the WebSocket reloadConfig handler.
 *
 * Typical usage after pulling updated config from the cloud worker API:
 *   1. execCommand("knowhow cloudworker --pull <cloudWorkerId>")
 *   2. reloadConfig()
 */
export function makeReloadConfigTool(
  Mcp: McpService,
  Tools: ToolsService,
  mcpServer: McpServerService,
  setToolsToUse: (tools: ReturnType<typeof Tools.getToolsByNames>) => void
) {
  const reloadConfig = async (): Promise<ReloadConfigResult> => {
    try {
      // Re-read fresh config from disk
      const freshConfig = await getConfig();

      // Close all existing MCP connections
      await Mcp.closeAll();

      // Reconnect from fresh config and re-register tools
      await Mcp.connectToConfigured(Tools);

      // Rebuild the allowed tools list from fresh config
      const allowedToolNames =
        freshConfig.worker?.allowedTools ?? Tools.getToolNames();
      const newToolsToUse = Tools.getToolsByNames(allowedToolNames);
      setToolsToUse(newToolsToUse);

      // Update the MCP server with the new tool list
      mcpServer.withTools(newToolsToUse);

      const mcpCount = freshConfig.mcps?.length ?? 0;

      return {
        success: true,
        toolCount: newToolsToUse.length,
        mcpCount,
        message: `Config reloaded: ${newToolsToUse.length} tools active, ${mcpCount} MCP(s) configured`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        toolCount: 0,
        mcpCount: 0,
        message: `Failed to reload config: ${message}`,
      };
    }
  };

  const reloadConfigDefinition: Tool = {
    type: "function" as const,
    function: {
      name: "reloadConfig",
      description:
        "Reload the worker config from disk, reconnect all MCPs, and rebuild the active tool list. " +
        "Call this after running `knowhow cloudworker --pull <id>` to apply updated MCPs without restarting the worker.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  };

  return { reloadConfig, reloadConfigDefinition };
}
