export * from "./listAllowedPorts";
import {
  listAllowedPorts,
  listAllowedPortsDefinition,
} from "./listAllowedPorts";

export default {
  tools: { listAllowedPorts },
  definitions: [listAllowedPortsDefinition],
};
