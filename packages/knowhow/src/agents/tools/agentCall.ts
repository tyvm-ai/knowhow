import { getConfig } from "../../config";
import { services, ToolsService } from "../../services";

export async function agentCall(agentName: string, userInput: string) {
  return new Promise(async (resolve, reject) => {
    const config = await getConfig();
    const toolService = (
      this instanceof ToolsService ? this : services().Tools
    ) as ToolsService;

    const { Events, Plugins } = toolService.getContext();

    let fullPrompt = `${userInput}`;
    if (config.plugins?.length) {
      const pluginText = await Plugins.callMany(config.plugins, userInput);
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
