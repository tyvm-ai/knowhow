import { getConfig } from "../../config";
import { ToolsService } from "../../services";

export async function agentCall(agentName: string, userInput: string) {
  return new Promise(async (resolve, reject) => {
    const config = await getConfig();
    const toolService = this as ToolsService;

    const { eventService, pluginService } = toolService.getContext();
    const pluginText = await pluginService.callMany(config.plugins, userInput);
    const fullPrompt = `${userInput} \n ${pluginText}`;

    eventService.emit("agents:call", {
      name: agentName,
      query: fullPrompt,
      resolve,
      reject,
    });
  });
}
