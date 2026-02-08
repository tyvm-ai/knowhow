import { LazyToolsService } from "../../../services/LazyToolsService";
import { ToolsService } from "../../../services/Tools";

export async function listAvailableTools(this: ToolsService) {
  if (!(this instanceof LazyToolsService)) {
    return {
      error: "This tool requires LazyToolsService",
      message:
        "listAvailableTools is only available when using LazyToolsService",
    };
  }

  return this.listAvailableTools();
}
