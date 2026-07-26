import { getConfig } from "../../config";
import { services, ToolsService } from "../../services";
import { getEnabledPlugins } from "../../types";

/**
 * Ask another registered agent a question. Resolves with a structured
 * `{ answer, costUsd }` object (via `AgentService.callAgent`) so callers — most
 * importantly the script sandbox — can account the subagent's spend against a
 * budget. `answer` is the target agent's final response.
 */
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
