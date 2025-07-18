import { Events } from "../../services/EventService";
import { Plugins } from "../../plugins/plugins";
import { getConfig } from "../../config";

export async function agentCall(agentName: string, userInput: string) {
  return new Promise(async (resolve, reject) => {
    const config = await getConfig();
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
