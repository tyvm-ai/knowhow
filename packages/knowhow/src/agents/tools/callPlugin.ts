import { services } from "../../services";
import { ToolsService } from "../../services";
export async function callPlugin(pluginName: string, userInput: string) {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  return toolService.getContext().Plugins.call(pluginName, userInput);
}
