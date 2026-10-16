/**
 * Settings of the shared services (everything that isn't a pack): the gaze hub, recovery policy, logging,
 * eye tracking and the `~/.knowhow/voice/` store. Packs declare their own settings on `defineVoicePack({ config })`.
 *
 *   knowhow.json → voiceControl.services.<service>.<key>
 */

import { homedir } from "os";
import { join } from "path";
import type { ConfigSchema, ConfigValues } from "./schema";
import { configField, nonEmpty, oneOf } from "./schema";

export const DEFAULT_HUB_URL = "http://127.0.0.1:7465";

export type LogLevelSetting = "debug" | "info" | "warn" | "error" | "silent";
export type InferPolicySetting = "auto" | "confirm" | "off";

const stripGazeUrl = (raw: string): string | undefined => {
  const url = raw.trim().replace(/\/api\/gaze\/?$/, "").replace(/\/$/, "");
  return url || undefined;
};

export const GAZE_SERVICE_CONFIG = {
  url: configField<string>({
    default: DEFAULT_HUB_URL,
    // first one that is set wins (KNOWHOW_EYE_HUB_URL is the canonical name; the others are older aliases)
    env: ["KNOWHOW_EYE_HUB_URL", "KNOWHOW_EYE_URL", "KNOWHOW_GAZE_URL"],
    parse: stripGazeUrl,
    description: "Eye-tracking hub base URL",
  }),
} satisfies ConfigSchema;

export const RECOVERY_SERVICE_CONFIG = {
  infer: configField<InferPolicySetting | undefined>({
    default: undefined,
    env: "KNOWHOW_VOICE_INFER",
    parse: oneOf<InferPolicySetting>("auto", "confirm", "off"),
    description: "How guessed commands run: auto (run), confirm (always ask), off. Unset = each recoverer decides",
  }),
} satisfies ConfigSchema;

export const LOG_SERVICE_CONFIG = {
  level: configField<LogLevelSetting>({
    default: "info",
    env: "KNOWHOW_VOICE_LOG_LEVEL",
    parse: oneOf<LogLevelSetting>("debug", "info", "warn", "error", "silent"),
    description: "Minimum level the [voice] logger prints",
  }),
} satisfies ConfigSchema;

export const EYE_SERVICE_CONFIG = {
  python: configField<string | undefined>({
    default: undefined,
    env: "KNOWHOW_EYE_PYTHON",
    legacyJson: ["voiceControl.eyeTracking.python"],
    parse: nonEmpty,
    description: "Python executable with mediapipe/opencv for the eye tracker (unset = the venv, else python3)",
  }),
} satisfies ConfigSchema;

export const STORE_SERVICE_CONFIG = {
  dir: configField<string>({
    default: join(homedir(), ".knowhow", "voice"),
    env: "KNOWHOW_VOICE_DIR",
    parse: nonEmpty,
    description: "Directory of the runtime store (learned intents, app aliases, …)",
  }),
  learnedFile: configField<string | undefined>({
    default: undefined,
    env: "KNOWHOW_VOICE_LEARNED_FILE",
    parse: nonEmpty,
    description: "Learned-intents file (unset = <dir>/learned.json)",
  }),
  legacyIntentsFile: configField<string>({
    default: join(homedir(), ".knowhow", "voice-learned-intents.json"),
    env: "KNOWHOW_VOICE_LEARNED_INTENTS_FILE",
    parse: nonEmpty,
    description: "Old {tmuxPrefixes} file migrated into the learned store on first load",
  }),
  legacyAppAliasesFile: configField<string>({
    default: join(homedir(), ".knowhow", "voice-app-aliases.json"),
    env: "KNOWHOW_VOICE_APP_ALIASES_FILE",
    parse: nonEmpty,
    description: "Old {spoken: app} file migrated into the learned store on first load",
  }),
} satisfies ConfigSchema;

/** Every service's schema, by service name (what `voice-control config` lists). */
export const SERVICE_SCHEMAS: Record<string, ConfigSchema> = {
  gaze: GAZE_SERVICE_CONFIG,
  recovery: RECOVERY_SERVICE_CONFIG,
  log: LOG_SERVICE_CONFIG,
  eyeTracking: EYE_SERVICE_CONFIG,
  store: STORE_SERVICE_CONFIG,
};

export type GazeServiceConfig = ConfigValues<typeof GAZE_SERVICE_CONFIG>;
