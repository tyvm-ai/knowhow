import { LazyToolsService } from "../../../services/LazyToolsService";
import { ToolsService } from "../../../services/Tools";

export async function disableTools(
  this: ToolsService,
  patterns: string[]
) {
  if (!(this instanceof LazyToolsService)) {
    return {
      error: "This tool requires LazyToolsService",
      message: "disableTools is only available when using LazyToolsService",
    };
  }

  return this.disableTools(patterns);
}
