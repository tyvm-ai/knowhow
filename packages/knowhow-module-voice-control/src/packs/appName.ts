/**
 * app-name pack: contributes the "did you mean this app?" recoverer
 * (appSuggest.ts). No commands of its own.
 */

import { appNameRecoverer } from "../appSuggest";
import { defineVoicePack } from "./define";

export const APP_NAME_PACK = defineVoicePack({
  name: "app-name",
  description: "Suggests the closest running app when a command's {app} slot sounds like one",
  commands: [],
  recoverers: [appNameRecoverer],
});
