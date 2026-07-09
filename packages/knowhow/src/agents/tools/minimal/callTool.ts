import { minimatch } from "minimatch";
import { MinimalToolsService } from "../../../services/MinimalToolsService";
import { ToolsService } from "../../../services/Tools";

/**
 * Calls any tool by name with the given args.
 * This is the escape hatch that lets agents call tools outside the base tool set
 * without changing the `tools:` array sent to the AI (preserving cache stability).
 */
export async function callTool(
  this: ToolsService,
  args: { name: string; args: Record<string, any> }
): Promise<any> {
  const service = this as unknown as MinimalToolsService;
  const { name, args: toolArgs } = args;

  const allTools = service.getAllTools ? service.getAllTools() : service.getTools();

  // Fuzzy match: exact, endsWith, or glob
  const matchedTool =
    allTools.find((t) => t.function.name === name) ||
    allTools.find((t) => t.function.name.endsWith(name)) ||
    allTools.find((t) => minimatch(t.function.name, name, { nocase: true }));

  if (!matchedTool) {
    const available = allTools.map((t) => t.function.name).join(", ");
    return `Error: Tool "${name}" not found. Use inspectTools() to browse available tools. Available: ${available}`;
  }

  const toolName = matchedTool.function.name;

  // Build a synthetic ToolCall object and delegate to the base callTool
  const syntheticToolCall = {
    id: `call_minimal_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    type: "function" as const,
    function: {
      name: toolName,
      arguments: JSON.stringify(toolArgs),
    },
  };

  // Use base ToolsService.callTool with the matched tool name allowed
  const result = await service.callToolByName(syntheticToolCall, toolName);
  return result;
}
