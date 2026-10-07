import type { ConfigValues } from "../config/schema";
import { configField, numberAtLeast, oneOf } from "../config/schema";
import type { HintDensity } from "./density";
import type { HintSource } from "./types";

/**
 * Settings of the hints pack — `knowhow.json → voiceControl.packs.hints.<key>`, env override in brackets.
 * Read when a command runs (`ctx.config.density`), so they can change mid-session.
 */
export const HINTS_CONFIG = {
  density: configField<HintDensity>({
    default: "all",
    env: "KNOWHOW_HINT_DENSITY",
    parse: oneOf<HintDensity>("few", "normal", "more", "all"),
    description: "How many hints to show: few | normal | more | all (full-window parse). \"more hints\" / \"fewer hints\" change it for the session",
  }),
  source: configField<HintSource>({
    default: "auto",
    env: "KNOWHOW_HINT_SOURCE",
    parse: oneOf<HintSource>("auto", "ax", "visual", "both"),
    description: "Where candidates come from: auto (AX, then visual when AX is empty) | ax | visual (screenshot OCR) | both",
  }),
  mapRefreshMs: configField<number>({
    default: 3000,
    env: "KNOWHOW_MAP_REFRESH_MS",
    parse: numberAtLeast(0),
    description: "How often a shown map is re-parsed in the background (ms); 0 disables auto-refresh",
  }),
};

export type HintsConfig = ConfigValues<typeof HINTS_CONFIG>;
