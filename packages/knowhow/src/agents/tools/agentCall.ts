import { getConfig } from "../../config";
import { services, ToolsService } from "../../services";
import { getEnabledPlugins } from "../../types";

export async function agentCall(agentName: string, userInput: string) {
  return new Promise(async (resolve, reject) => {
    const config = await getConfig();
    const toolService = (
      this instanceof ToolsService ? this : services().Tools
    ) as ToolsService;

    const { Events, Plugins } = toolService.getContext();

    let fullPrompt = `${userInput}`;
    const enabledPlugins = getEnabledPlugins(config.plugins);
    if (enabledPlugins?.length) {
      const pluginText = await Plugins.callMany(enabledPlugins, userInput);
      fullPrompt += `\n ${pluginText}`;
    }

    Events.emit("agents:call", {
      name: agentName,
      query: fullPrompt,
      resolve,
      reject,
    });
  });
}
