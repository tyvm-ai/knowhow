export * from "./listAllowedPorts";
export * from "./getChallenge";
export * from "./unlock";
export * from "./lock";
export * from "./reloadConfig";

import {
  listAllowedPorts,
  listAllowedPortsDefinition,
} from "./listAllowedPorts";

export { makeGetChallengeTool } from "./getChallenge";
export { makeUnlockTool } from "./unlock";
export { makeLockTool } from "./lock";
export { makeReloadConfigTool } from "./reloadConfig";

export default {
  tools: { listAllowedPorts },
  definitions: [listAllowedPortsDefinition],
};
