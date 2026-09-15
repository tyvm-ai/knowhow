import { getConfig } from "../../config";
import { Tool } from "../../clients/types";
import { AllowedTunnelPort } from "../../types";

/**
 * Tool to list all forwarded ports configured for the worker tunnel
 * This reads from the worker.tunnel.allowedPorts configuration
 */
export async function listAllowedPorts(): Promise<AllowedTunnelPort[]> {
  const config = await getConfig();

  if (!config.worker?.tunnel?.enabled) {
    return [];
  }

  return config.worker.tunnel.allowedPorts || [];
}

export const listAllowedPortsDefinition: Tool = {
  type: "function" as const,
  function: {
    name: "listAllowedPorts",
    description:
      "List all ports forwarded through the worker tunnel, including optional transport and application metadata.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};
