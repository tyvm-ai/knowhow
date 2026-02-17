import { getConfig } from "../../config";
import { Tool } from "../../clients/types";

/**
 * Tool to list all forwarded ports configured for the worker tunnel
 * This reads from the worker.tunnel.allowedPorts configuration
 */
export async function listAllowedPorts(): Promise<number[]> {
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
      "List all ports that are being forwarded through the worker tunnel. Returns an array of port numbers that can be accessed via the tunnel system.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};
