import { LazyToolsService } from "../../../services/LazyToolsService";
import { ToolsService } from "../../../services/Tools";

export async function enableTools(
  this: ToolsService,
  patterns: string[]
) {
  if (!(this instanceof LazyToolsService)) {
    return {
      error: "This tool requires LazyToolsService",
      message: "enableTools is only available when using LazyToolsService",
    };
  }

  return this.enableTools(patterns);
}
