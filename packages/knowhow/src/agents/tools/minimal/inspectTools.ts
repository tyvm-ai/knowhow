import { minimatch } from "minimatch";
import { MinimalToolsService } from "../../../services/MinimalToolsService";
import { ToolsService } from "../../../services/Tools";

/**
 * Returns the full tool definitions (schema) for all tools matching the given patterns.
 * Used by agents to discover argument shapes before calling via callTool.
 */
export function inspectTools(
  this: ToolsService,
  patterns?: string[]
): object[] {
  const service = this as unknown as MinimalToolsService;
  const allTools = service.getAllTools ? service.getAllTools() : service.getTools();

  if (!patterns || patterns.length === 0) {
    return allTools.map((t) => t.function);
  }

  return allTools
    .filter((t) =>
      patterns.some((pattern) =>
        minimatch(t.function.name, pattern, { nocase: true })
      )
    )
    .map((t) => t.function);
}
