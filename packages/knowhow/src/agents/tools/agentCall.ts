import { getConfig } from "../../config";
import { ToolsService } from "../../services";

export async function agentCall(agentName: string, userInput: string) {
  return new Promise(async (resolve, reject) => {
    const config = await getConfig();
    const toolService = this as ToolsService;

    const { Events, Plugins } = toolService.getContext();
    const pluginText = await Plugins.callMany(config.plugins, userInput);
    const fullPrompt = `${userInput} \n ${pluginText}`;

    Events.emit("agents:call", {
      name: agentName,
      query: fullPrompt,
      resolve,
      reject,
    });
  });
}
